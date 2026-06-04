#!/usr/bin/env node
// Downloads NaturalEarth + GeoNames source data and emits the two static
// files the web app consumes:
//   data/background.pmtiles  — tippecanoe-built MVT vector tiles
//   data/cities.bin          — cities sorted by score, packed binary
//
// The binary layout (little-endian) lets the worker map TypedArray views
// directly over the fetched ArrayBuffer with zero parse cost.
//
// Header (11 × u32 = 44 bytes), each a byte offset into the buffer:
//   count, xsOff, ysOff, popsOff,
//   nameOffsetsOff, namesOff,            ← city name only ("Paris"), for map labels
//   displayOffsetsOff, displaysOff,      ← formatted search row ("🇫🇷 Paris, France")
//   searchOffsetsOff, searchesOff, totalSize
//
// Coordinates ship pre-projected to EPSG:3857 (Web Mercator metres), so the
// main thread never calls fromLonLat() on a city and the worker scans bbox
// queries in the same units the OL view already speaks.
//
// Each city's `display` string is the fully-formatted search row, baked at
// build time: `🇫🇷 Paris, France`. The renderer just `innerHTML`s the bytes
// — no runtime Intl.DisplayNames, no flag computation, no city/country
// concatenation, no arrondissement-style dedup (PPLX is filtered upfront
// AND "Paris 15 Vaugirard"-like duplicates are folded into the parent).
//
// Sections (each starts at its declared offset, padded to 4 bytes):
//   [f32  * count]    xs   (mercator metres)
//   [f32  * count]    ys   (mercator metres)
//   [u32  * count]    populations
//   [u32  * count+1]  display-string end offsets
//   [u8   * total_d]  utf-8 display string bytes  ("🇫🇷 Paris, France")
//   [u32  * count+1]  search-string end offsets
//   [u8   * total_s]  normalized "name countryName countryCode" bytes

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(__dirname, ".data-cache");
const STAGE_DIR = path.join(CACHE_DIR, "staged");
const OUT_DIR = path.join(__dirname, "data");

// Web Mercator forward projection — matches OL's EPSG:3857. Keeping a copy
// here means build-data doesn't need to import OL or proj4.
const RAD = Math.PI / 180;
const EARTH_RADIUS = 6378137;
function lonToMercatorX(lon) {
  return lon * RAD * EARTH_RADIUS;
}
function latToMercatorY(lat) {
  // Clamp to ±85.0511°: beyond that Mercator blows up to ±∞.
  const clamped = Math.max(-85.05112878, Math.min(85.05112878, lat));
  return Math.log(Math.tan((90 + clamped) * RAD / 2)) * EARTH_RADIUS;
}

// Each source feeds an MVT layer of the same name in the produced PMTiles
// archive — the OL style function dispatches on `feature.get('featureClass')`
// which is set from the MVT layer name (zero-cost lookup, no property
// switching). `minZoom`/`maxZoom` bake the zoom-level-of-detail decision into
// the tile contents: tippecanoe simply omits the feature from tiles outside
// that range so the runtime never has to filter on resolution.
//
// `keep` is an optional list of source-property keys to copy through (river
// scalerank is the one we still want at runtime; everything else is dropped).
const BACKGROUND_SOURCES = [
  { class: "bathymetry_deep",    url: "https://d2ad6b4ur7yvpq.cloudfront.net/naturalearth-3.3.0/ne_10m_bathymetry_E_6000.geojson" },
  { class: "bathymetry_shallow", url: "https://d2ad6b4ur7yvpq.cloudfront.net/naturalearth-3.3.0/ne_10m_bathymetry_J_1000.geojson" },
  { class: "glacier",            url: "https://d2ad6b4ur7yvpq.cloudfront.net/naturalearth-3.3.0/ne_50m_glaciated_areas.geojson" },
  { class: "lake",               url: "https://d2ad6b4ur7yvpq.cloudfront.net/naturalearth-3.3.0/ne_10m_lakes.geojson" },
  { class: "land",               url: "https://d2ad6b4ur7yvpq.cloudfront.net/naturalearth-3.3.0/ne_50m_land.geojson" },
  // Marine polys are area-LOD'd per-feature (see `marineMinZoomForArea`) so
  // big oceans show at the world view and smaller seas appear progressively
  // as you zoom in. No source-level maxZoom — once a sea is visible the
  // label should stay through deeper zooms.
  { class: "marine",             url: "https://d2ad6b4ur7yvpq.cloudfront.net/naturalearth-3.3.0/ne_10m_geography_marine_polys.geojson" },
  // Regional high-detail rivers — only meaningful at close zoom.
  { class: "river_detail",       url: "https://d2ad6b4ur7yvpq.cloudfront.net/naturalearth-3.3.0/ne_10m_rivers_europe.geojson",        minZoom: 7 },
  { class: "river_detail",       url: "https://d2ad6b4ur7yvpq.cloudfront.net/naturalearth-3.3.0/ne_10m_rivers_north_america.geojson", minZoom: 7 },
  // Global rivers with scale_rank (1 = Amazon-class, 10 = creek). Per-feature
  // minzoom (see `riverMinZoomForRank` below) lets tippecanoe drop low-rank
  // rivers from low-zoom tiles entirely — no runtime LOD logic needed.
  { class: "river",              url: "https://d2ad6b4ur7yvpq.cloudfront.net/naturalearth-3.3.0/ne_50m_rivers_lake_centerlines_scale_rank.geojson", keep: ["scalerank"] },
  // Built-up urban area polygons — drawable city footprints. They're small,
  // so only render once we're zoomed in enough to see them as more than a dot.
  // (The cloudfront mirror omits these two files, so we go straight to the
  // nvkelso/natural-earth-vector GitHub mirror.)
  { class: "urban_area",         url: "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_urban_areas.geojson", minZoom: 5 },
  // Major historic-era roads. NaturalEarth `scalerank` (1 = arterial, 12 =
  // track) drives per-feature minzoom via `roadMinZoomForRank` below.
  // The same source contains ferry routes (featurecla="Ferry") — splitting
  // them into a separate MVT layer ("sea_route") lets the renderer give them
  // a distinctly maritime style (dashed sepia) instead of a road brown.
  { class: "road",               url: "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_roads.geojson", keep: ["scalerank"], filter: (p) => p?.featurecla !== "Ferry" },
  { class: "sea_route",          url: "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_roads.geojson", keep: ["scalerank"], filter: (p) => p?.featurecla === "Ferry" },
  // Mountain peaks (elevation points). Each feature carries its NaturalEarth
  // `min_zoom` recommendation, which we honour at build time so cluttery
  // minor peaks only appear when the user zooms in.
  { class: "peak",               url: "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_geography_regions_elevation_points.geojson", keep: ["name", "elevation"], filter: (p) => p?.featurecla === "mountain" },
];

// The runtime view zooms past z=18 (wheel-zoom street level). OL overzooms
// vector tiles past this by upscaling the geometry — so even at z=18 the
// textures stay present, just lower-resolution. 10 strikes a balance:
// archive size stays manageable (one-off build cost grows ~4× per zoom) and
// the geometry is finer than period cartography would justify anyway.
const PMTILES_MAX_ZOOM = 10;

// Maps NaturalEarth scalerank (1 = Amazon-class, 10 = creek) to the MVT zoom
// level at which the river starts appearing. Tippecanoe's `tippecanoe.minzoom`
// per-feature tag honours this — anything below that zoom doesn't carry the
// bytes for the river at all.
function riverMinZoomForRank(rank) {
  if (rank <= 2) return 0;
  // Slope chosen to match the previous runtime resolution thresholds.
  return Math.min(PMTILES_MAX_ZOOM, rank);
}

// NaturalEarth road scalerank (lower = more important). Coarse mapping:
// world arterials at z 3, regional at z 5, local at z 7. Anything past 10
// is decorative noise on a retro map.
function roadMinZoomForRank(rank) {
  if (rank <= 3) return 3;
  if (rank <= 5) return 5;
  if (rank <= 7) return 6;
  if (rank <= 9) return 7;
  return Math.min(PMTILES_MAX_ZOOM, 8);
}

// Spherical-excess area of a single ring in steradians; multiply by R² for
// m². Good enough for "is this sea bigger or smaller than that one" — we
// just need a ranking, not survey-grade numbers.
function ringSteradians(ring) {
  let total = 0;
  const n = ring.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const [lon1, lat1] = ring[j];
    const [lon2, lat2] = ring[i];
    total += (lon2 - lon1) * Math.PI / 180 *
      (2 + Math.sin(lat1 * Math.PI / 180) + Math.sin(lat2 * Math.PI / 180));
  }
  return Math.abs(total / 2);
}

function geometryAreaSr(geom) {
  if (!geom) return 0;
  if (geom.type === "Polygon") {
    return ringSteradians(geom.coordinates[0]);
  }
  if (geom.type === "MultiPolygon") {
    let s = 0;
    for (const poly of geom.coordinates) s += ringSteradians(poly[0]);
    return s;
  }
  return 0;
}

// Map a marine polygon's solid-angle area to a minimum zoom level.
// Calibrated against NaturalEarth's actual marine_polys areas:
//   ~ 0.4-1.9 sr  → the six big oceans               → z 0
//   ~ 0.1-0.15 sr → Philippine Sea, Arabian Sea, …   → z 2
//   ~ 0.05-0.1 sr → Coral Sea, Bering, Caribbean, …  → z 3
//   ~ 0.02-0.05 sr → Gulf of Mexico, Norwegian, …    → z 4
//   ~ 0.005-0.02 sr → Hudson Bay, Andaman, Banda, …  → z 5
//   smaller bays / straits / channels                → z 6+
// The aggressive low-zoom cutoff is what makes the world view look like
// a period atlas (oceans labelled, nothing else competing for ink).
function marineMinZoomForArea(sr) {
  if (sr > 0.4)    return 0;
  if (sr > 0.1)    return 2;
  if (sr > 0.05)   return 3;
  if (sr > 0.02)   return 4;
  if (sr > 0.005)  return 5;
  if (sr > 0.001)  return 6;
  return 7;
}

const CITIES_URL = "https://download.geonames.org/export/dump/cities500.zip";

async function downloadCached(url) {
  await fs.mkdir(CACHE_DIR, { recursive: true });
  const cachePath = path.join(CACHE_DIR, path.basename(url));
  try {
    await fs.access(cachePath);
    return cachePath;
  } catch {}
  console.log("download", url);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.writeFile(cachePath, buf);
  return cachePath;
}

function titleCase(s) {
  return s
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\S+/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase());
}

async function ensureTippecanoe() {
  return new Promise((resolve, reject) => {
    const p = spawn("tippecanoe", ["--version"], { stdio: "ignore" });
    p.once("error", () => {
      reject(new Error(
        "tippecanoe not found on PATH. Install it locally to regenerate " +
        "background.pmtiles:\n" +
        "  macOS:   brew install tippecanoe\n" +
        "  Ubuntu:  sudo apt-get install -y tippecanoe\n" +
        "CI does not need tippecanoe — it uses the committed data/background.pmtiles.",
      ));
    });
    p.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`tippecanoe --version exited ${code}`)));
  });
}

async function stageBackgroundSource(source, index) {
  const filePath = await downloadCached(source.url);
  const fc = JSON.parse(await fs.readFile(filePath, "utf8"));
  const staged = [];
  for (const feature of fc.features) {
    if (!feature.geometry?.coordinates) continue;
    if (source.filter && !source.filter(feature.properties)) continue;

    // Properties strictly used by the runtime style function. Anything else
    // is paid for in every tile, every render.
    const properties = {};
    const rawName = feature.properties?.name;
    if (typeof rawName === "string") {
      const name = titleCase(rawName);
      if (name) properties.name = name;
    }
    for (const key of source.keep || []) {
      if (feature.properties?.[key] !== undefined) {
        properties[key] = feature.properties[key];
      }
    }

    // Per-feature tippecanoe directives. River minzoom rides scalerank;
    // source-level minZoom/maxZoom apply to the whole class. CRUCIAL: the
    // `tippecanoe` key must sit at the FEATURE level (sibling to
    // `properties`), not inside it — otherwise tippecanoe stores it as a
    // string-encoded property value and silently ignores the directives.
    const tipp = {};
    if (source.minZoom !== undefined) tipp.minzoom = source.minZoom;
    if (source.maxZoom !== undefined) tipp.maxzoom = source.maxZoom;
    if (source.class === "river") {
      const rank = feature.properties?.scalerank ?? 5;
      tipp.minzoom = riverMinZoomForRank(rank);
    }
    if (source.class === "road") {
      const rank = feature.properties?.scalerank ?? 7;
      tipp.minzoom = roadMinZoomForRank(rank);
    }
    if (source.class === "sea_route") {
      // Ferries are sparse — let them appear with major regional roads.
      tipp.minzoom = 4;
    }
    if (source.class === "marine") {
      tipp.minzoom = marineMinZoomForArea(geometryAreaSr(feature.geometry));
    }
    if (source.class === "peak") {
      // NaturalEarth ships its own per-feature min_zoom; trust it.
      const z = feature.properties?.min_zoom;
      if (typeof z === "number") tipp.minzoom = Math.max(0, Math.min(PMTILES_MAX_ZOOM, Math.round(z)));
    }

    const out = {
      type: "Feature",
      properties,
      geometry: feature.geometry,
    };
    if (Object.keys(tipp).length > 0) out.tippecanoe = tipp;
    staged.push(out);
  }

  const stagedPath = path.join(STAGE_DIR, `${source.class}-${index}.geojson`);
  await fs.writeFile(stagedPath, JSON.stringify({ type: "FeatureCollection", features: staged }));
  return { class: source.class, file: stagedPath, count: staged.length };
}

async function runTippecanoe(args) {
  return new Promise((resolve, reject) => {
    const p = spawn("tippecanoe", args, { stdio: "inherit" });
    p.once("error", reject);
    p.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`tippecanoe exited ${code}`)));
  });
}

async function buildBackground() {
  await ensureTippecanoe();
  await fs.rm(STAGE_DIR, { recursive: true, force: true });
  await fs.mkdir(STAGE_DIR, { recursive: true });

  const staged = [];
  for (let i = 0; i < BACKGROUND_SOURCES.length; i++) {
    staged.push(await stageBackgroundSource(BACKGROUND_SOURCES[i], i));
  }

  const out = path.join(OUT_DIR, "background.pmtiles");
  await fs.rm(out, { force: true });

  // -Z0 / -z PMTILES_MAX_ZOOM: zoom range. --simplification: a touch above the
  // default for smaller tiles at low zoom. --coalesce-densest-as-needed lets
  // tippecanoe merge adjacent features when a tile would otherwise blow its
  // size budget — better than dropping. Per-feature tippecanoe.minzoom /
  // .maxzoom (set in stageBackgroundSource) handle LOD inside the archive.
  const args = [
    "-o", out,
    "-f",                                     // overwrite existing archive
    "-Z", "0",                                // min zoom
    "-z", String(PMTILES_MAX_ZOOM),           // max zoom
    "--simplification=6",                     // Visvalingam-Whyatt tolerance
    "--drop-densest-as-needed",               // drop low-importance features when a tile is too big
    "--extend-zooms-if-still-dropping",       // bump zoom on the rare tile that still overflows
    "--no-tiny-polygon-reduction",            // keep small lakes from getting eaten
    ...staged.flatMap((s) => ["-L", `${s.class}:${s.file}`]),
  ];
  // tippecanoe is happiest as one argv; print the assembled command for debug.
  console.log("tippecanoe", args.map((a) => /\s/.test(a) ? `"${a}"` : a).join(" "));
  await runTippecanoe(args);

  const totalIn = staged.reduce((acc, s) => acc + s.count, 0);
  const stat = await fs.stat(out);
  console.log(`wrote ${totalIn} features → ${path.relative(__dirname, out)} (${(stat.size / 1024 / 1024).toFixed(2)} MB)`);
}

function normalizeSearch(s) {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
}

async function buildCities() {
  const filePath = await downloadCached(CITIES_URL);
  const zip = await JSZip.loadAsync(await fs.readFile(filePath));
  const entry = zip.file("cities500.txt");
  if (!entry) throw new Error("cities500.txt missing from archive");
  const text = await entry.async("string");

  const countryName = new Intl.DisplayNames(["en"], { type: "region" });
  // Common informal aliases so users can type the country they expect.
  const COUNTRY_ALIASES = {
    GB: ["uk", "britain", "england"],
    US: ["usa", "america"],
    KR: ["south korea"],
    KP: ["north korea"],
    CZ: ["czechia"],
    AE: ["uae", "emirates"],
    RU: ["russia"],
    CD: ["drc", "congo"],
    CG: ["congo"],
    NL: ["holland"],
    VA: ["vatican"],
    CI: ["ivory coast"],
    TW: ["taiwan"],
  };
  // Two flavours of country string per ISO code, both cached:
  //   - display: the pretty form shown in the search palette ("France")
  //   - search:  the normalised tokens we scan for matches
  const countryDisplayCache = new Map();
  const countrySearchCache = new Map();

  function countryDisplayName(country) {
    let v = countryDisplayCache.get(country);
    if (v === undefined) {
      try { v = countryName.of(country) || country; } catch { v = country; }
      countryDisplayCache.set(country, v);
    }
    return v;
  }

  function countrySearchString(country) {
    let cn = countrySearchCache.get(country);
    if (cn === undefined) {
      const parts = [];
      const en = countryDisplayName(country);
      if (en) parts.push(normalizeSearch(en));
      for (const alias of COUNTRY_ALIASES[country] || []) {
        parts.push(normalizeSearch(alias));
      }
      cn = parts.join(" ");
      countrySearchCache.set(country, cn);
    }
    return cn;
  }

  function searchString(name, asciiName, country) {
    return [normalizeSearch(asciiName || name), countrySearchString(country), country.toLowerCase()]
      .filter(Boolean)
      .join(" ");
  }

  // Two regional-indicator codepoints from the ISO alpha-2 country code.
  // 'F','R' → U+1F1EB U+1F1F7 → 🇫🇷
  function flagEmoji(country) {
    const a = country.charCodeAt(0);
    const b = country.charCodeAt(1);
    if (a < 65 || a > 90 || b < 65 || b > 90) return "";
    return String.fromCodePoint(0x1F1E6 + a - 65, 0x1F1E6 + b - 65);
  }

  let cities = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    const cols = line.split("\t");
    const featureCode = cols[7];
    // PPLX is "section of populated place" — arrondissements, NYC boroughs,
    // etc. They duplicate the parent city in search results, so drop them.
    if (featureCode === "PPLX") continue;
    const country = (cols[8] || "  ").padEnd(2).slice(0, 2);
    const population = parseInt(cols[14], 10) || 0;
    let score = population;
    if (featureCode === "PPLC") score += 1_000_000_000;
    else if (featureCode === "PPLA") score += 100_000_000;
    const lon = parseFloat(cols[5]);
    const lat = parseFloat(cols[4]);
    const name = cols[1];
    const flag = flagEmoji(country);
    const display = `${flag ? flag + " " : ""}${name}, ${countryDisplayName(country)}`;
    cities.push({
      name,
      country,
      population,
      x: lonToMercatorX(lon),
      y: latToMercatorY(lat),
      score,
      display,
      search: searchString(name, cols[2], country),
    });
  }
  cities.sort((a, b) => b.score - a.score);

  // Two passes of dedup, both relying on the score-sorted iteration above
  // (parents/best-scored entries come first, so a one-pass keep-first scan
  // is sound). The runtime search palette can trust these decisions — no
  // runtime dedup, no runtime Intl.
  //   1. Fold arrondissement-style "Paris 15 Vaugirard" entries into the
  //      parent "Paris" of the same country.
  //   2. Collapse identical (name, country) pairs (e.g. 6 different US
  //      towns named "Paris" all in TX/TN/KY/...) down to the single
  //      highest-scored one — the search palette format is "City, Country"
  //      so multiple rows would look identical and confuse the user.
  const PREFIX_DUPE_RE = /^(.+?) \d/;
  const keptByExact = new Map();   // `${name}|${country}` → true
  const folded = [];
  for (const c of cities) {
    const exactKey = `${c.name}|${c.country}`;
    if (keptByExact.has(exactKey)) continue;
    const m = c.name.match(PREFIX_DUPE_RE);
    if (m) {
      const parentKey = `${m[1]}|${c.country}`;
      if (keptByExact.has(parentKey)) continue;
    }
    folded.push(c);
    keptByExact.set(exactKey, true);
  }
  const droppedDupes = cities.length - folded.length;
  console.log(`folded ${droppedDupes} duplicate / section-of-city entries`);
  // Reassign — `cities.push(...folded)` blows the call stack at 200k items.
  cities = folded;

  const count = cities.length;
  const enc = new TextEncoder();
  const nameBytes = cities.map((c) => enc.encode(c.name));
  const displayBytes = cities.map((c) => enc.encode(c.display));
  const searchBytes = cities.map((c) => enc.encode(c.search));
  const totalNameBytes = nameBytes.reduce((acc, b) => acc + b.length, 0);
  const totalDisplayBytes = displayBytes.reduce((acc, b) => acc + b.length, 0);
  const totalSearchBytes = searchBytes.reduce((acc, b) => acc + b.length, 0);

  const HEADER_FIELDS = 11;
  const headerSize = HEADER_FIELDS * 4;
  const pad4 = (n) => (n + 3) & ~3;

  const xsOff = headerSize;
  const ysOff = xsOff + count * 4;
  const popsOff = ysOff + count * 4;
  const nameOffsetsOff = popsOff + count * 4;
  const namesOff = nameOffsetsOff + (count + 1) * 4;
  const displayOffsetsOff = pad4(namesOff + totalNameBytes);
  const displaysOff = displayOffsetsOff + (count + 1) * 4;
  const searchOffsetsOff = pad4(displaysOff + totalDisplayBytes);
  const searchesOff = searchOffsetsOff + (count + 1) * 4;
  const totalSize = pad4(searchesOff + totalSearchBytes);

  const buf = new ArrayBuffer(totalSize);
  const header = new Uint32Array(buf, 0, HEADER_FIELDS);
  header.set([
    count,
    xsOff, ysOff, popsOff,
    nameOffsetsOff, namesOff,
    displayOffsetsOff, displaysOff,
    searchOffsetsOff, searchesOff,
    totalSize,
  ]);

  const xs = new Float32Array(buf, xsOff, count);
  const ys = new Float32Array(buf, ysOff, count);
  const pops = new Uint32Array(buf, popsOff, count);
  const nameOffsets = new Uint32Array(buf, nameOffsetsOff, count + 1);
  const names = new Uint8Array(buf, namesOff, totalNameBytes);
  const displayOffsets = new Uint32Array(buf, displayOffsetsOff, count + 1);
  const displays = new Uint8Array(buf, displaysOff, totalDisplayBytes);
  const searchOffsets = new Uint32Array(buf, searchOffsetsOff, count + 1);
  const searches = new Uint8Array(buf, searchesOff, totalSearchBytes);

  let nameCursor = 0;
  let displayCursor = 0;
  let searchCursor = 0;
  for (let i = 0; i < count; i++) {
    xs[i] = cities[i].x;
    ys[i] = cities[i].y;
    pops[i] = cities[i].population;

    nameOffsets[i] = nameCursor;
    names.set(nameBytes[i], nameCursor);
    nameCursor += nameBytes[i].length;

    displayOffsets[i] = displayCursor;
    displays.set(displayBytes[i], displayCursor);
    displayCursor += displayBytes[i].length;

    searchOffsets[i] = searchCursor;
    searches.set(searchBytes[i], searchCursor);
    searchCursor += searchBytes[i].length;
  }
  nameOffsets[count] = nameCursor;
  displayOffsets[count] = displayCursor;
  searchOffsets[count] = searchCursor;

  const out = path.join(OUT_DIR, "cities.bin");
  await fs.writeFile(out, Buffer.from(buf));
  console.log(`wrote ${count} cities → ${path.relative(__dirname, out)} (${(buf.byteLength / 1024 / 1024).toFixed(2)} MB)`);
}

await fs.mkdir(OUT_DIR, { recursive: true });
await Promise.all([buildBackground(), buildCities()]);
