#!/usr/bin/env node
// Downloads NaturalEarth + GeoNames + Smithsonian + Wikidata source data and
// emits the static files the web app consumes:
//
//   data/background.pmtiles  — tippecanoe-built MVT vector tiles
//   data/cities.bin          — cities sorted by score, packed binary
//   data/volcanoes.bin       — Smithsonian Holocene volcanoes
//   data/seamounts.bin       — Wikidata seamounts (Q207326)
//   data/megaliths.bin       — Wikidata megalithic monuments (dolmens etc.)
//   data/facts.bin           — Wikidata historical events with coords + dates
//
// Bin layout (little-endian, shared across every point dataset). The worker
// maps TypedArray views directly over the fetched ArrayBuffer with zero parse
// cost — same trick as cities.bin, generalized so one worker code-path serves
// every dataset.
//
// Header (10 × u32 = 40 bytes), each a byte offset into the buffer:
//   count,
//   xsOff, ysOff,
//   scoresOff, zoomsOff,
//   labelOffsetsOff, labelsOff,
//   metaOffsetsOff,  metasOff,
//   totalSize
//
// Sections (each starts at its declared offset, padded to 4 bytes):
//   [f32  * count]    xs   (mercator metres)
//   [f32  * count]    ys   (mercator metres)
//   [u32  * count]    scores      (per-dataset; higher = more important)
//   [u8   * count]    zooms       (per-feature minZoom; padded to 4 bytes)
//   [u32  * count+1]  label-string end offsets
//   [u8   * total_l]  utf-8 label bytes (what shows on the map)
//   [u32  * count+1]  meta-string end offsets
//   [u8   * total_m]  utf-8 meta bytes (json-encoded extras for the popover)
//
// cities.bin keeps its own legacy layout for backward compat. The shared
// layout above is used for everything else.

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

// Each NaturalEarth bathymetry band maps to one PMTiles MVT layer. The depth
// suffix is the lower bound of the band in metres (so "K_200" covers 0–200 m,
// "A_10000" is below 10 km). Per-band layers let the renderer paint a stepped
// gradient by feature class without runtime property switching.
const BATHY_BANDS = [
  { class: "bathy_200",   url: "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_bathymetry_K_200.geojson",   depth:   200 },
  { class: "bathy_1000",  url: "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_bathymetry_J_1000.geojson",  depth:  1000 },
  { class: "bathy_2000",  url: "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_bathymetry_I_2000.geojson",  depth:  2000 },
  { class: "bathy_3000",  url: "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_bathymetry_H_3000.geojson",  depth:  3000 },
  { class: "bathy_4000",  url: "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_bathymetry_G_4000.geojson",  depth:  4000 },
  { class: "bathy_5000",  url: "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_bathymetry_F_5000.geojson",  depth:  5000 },
  { class: "bathy_6000",  url: "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_bathymetry_E_6000.geojson",  depth:  6000 },
  { class: "bathy_7000",  url: "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_bathymetry_D_7000.geojson",  depth:  7000 },
  { class: "bathy_8000",  url: "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_bathymetry_C_8000.geojson",  depth:  8000 },
  { class: "bathy_9000",  url: "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_bathymetry_B_9000.geojson",  depth:  9000 },
  { class: "bathy_10000", url: "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_bathymetry_A_10000.geojson", depth: 10000 },
];

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
  // Stepped bathymetry: 11 depth bands → 11 MVT layers. Each band is painted
  // a notch deeper-blue than the previous (see runtime style). The deepest
  // bands are nearly black; shallow shelves are a notch darker than open
  // water. Stacked with z-index in renderer so they paint shallow-over-deep.
  ...BATHY_BANDS.map((b) => ({ class: b.class, url: b.url })),
  { class: "glacier",            url: "https://d2ad6b4ur7yvpq.cloudfront.net/naturalearth-3.3.0/ne_50m_glaciated_areas.geojson" },
  { class: "lake",               url: "https://d2ad6b4ur7yvpq.cloudfront.net/naturalearth-3.3.0/ne_10m_lakes.geojson" },
  { class: "land",               url: "https://d2ad6b4ur7yvpq.cloudfront.net/naturalearth-3.3.0/ne_50m_land.geojson" },
  // Parks & protected lands — light parchment-green tint over land at higher
  // zooms only (low zooms would clutter the world view).
  { class: "park",               url: "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_parks_and_protected_lands_area.geojson", minZoom: 4 },
  // Mountain ranges, plateaus, basins, deserts, plains. Polygons tagged with
  // featurecla — used to paint mountain ranges a notch darker than the land
  // base (mimicking shaded relief without a DEM). Labels also drawn for the
  // big-ticket ranges at higher zooms.
  { class: "geo_region",         url: "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_geography_regions_polys.geojson", keep: ["featurecla", "region"] },
  // Marine polys are area-LOD'd per-feature (see `marineMinZoomForArea`) so
  // big oceans show at the world view and smaller seas appear progressively
  // as you zoom in. No source-level maxZoom — once a sea is visible the
  // label should stay through deeper zooms.
  // Marine polys carry per-feature `featurecla` ("ocean", "sea", "gulf",
  // "trench", "trough", "rise", ...) which the renderer uses to label
  // trenches and gulfs distinctly from generic seas.
  { class: "marine",             url: "https://d2ad6b4ur7yvpq.cloudfront.net/naturalearth-3.3.0/ne_10m_geography_marine_polys.geojson", keep: ["featurecla"] },
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

// NaturalEarth road scalerank (lower = more important). The rank
// distribution in ne_10m_roads has nothing below rank 3 — there's no
// world-scale "post road" rank in this dataset — and rank 3 alone is
// 10k features. A Europe-sized z=3 tile under the old curve carried
// 1200+ roads, which was the dominant cost of the z<=4.5 lag. Period
// maps at world view emphasised oceans, ranges and cities anyway; roads
// only need to show once the user is close enough to read a road.
function roadMinZoomForRank(rank) {
  if (rank <= 4) return 5;  // arterials — regional zoom
  if (rank <= 6) return 6;
  if (rank <= 8) return 7;
  return Math.min(PMTILES_MAX_ZOOM, 8);
}

// Geography-region polygons cover everything from the Andes (~3.5 sr) to a
// single named ridge (<0.001 sr). Big ranges and basins anchor the world
// view; minor features only earn ink at street-level zooms.
function geoRegionMinZoomForArea(sr) {
  if (sr > 0.3)   return 0;
  if (sr > 0.05)  return 2;
  if (sr > 0.01)  return 3;
  if (sr > 0.002) return 5;
  if (sr > 0.0005) return 6;
  return 7;
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

// Lake LOD. ne_10m_lakes has 1353 features — five of them are visible at
// world view (Caspian, Superior, Victoria, Huron, Michigan) and the next
// ~1300 are sub-pixel ponds invisible at z<6 but, without this gate, all
// 1300 still ended up in the z=0 tile and the renderer paid the per-
// feature style+rasterize cost for every one. Thresholds calibrated to
// be aggressive at the bottom of the distribution (so world tile stays
// fast) but loose enough that named regional lakes resurface by mid-zoom
// — Tahoe, Geneva, Como appear by z 3, not z 5.
function lakeMinZoomForArea(sr) {
  if (sr > 1e-4)   return 0;   // ~15 lakes: Erie, Tanganyika, Baikal, Aral
  if (sr > 1e-5)   return 2;   // ~60 lakes: Geneva, Tahoe, Constance, Garda
  if (sr > 1e-6)   return 4;   // most named regional lakes
  if (sr > 1e-7)   return 5;
  return 6;
}

// Glaciers: Antarctica + Greenland dominate, but a handful of named
// icefields (Patagonian, Vatnajökull, Malaspina) read well as scale cues
// at low zoom. Loosened from the first pass which only kept the big two.
function glacierMinZoomForArea(sr) {
  if (sr > 1e-3)   return 0;   // ~5 ice sheets / icefields
  if (sr > 1e-4)   return 2;   // bigger alpine systems
  if (sr > 1e-5)   return 4;
  return 6;
}

// Polylabel: pole of inaccessibility — the point inside a polygon that is
// furthest from any boundary. Used to bake a deterministic label anchor
// for each marine polygon at build time. The previous runtime path took
// the polygon's `getInteriorPoint` (unavailable on MVT RenderFeatures, so
// it actually fell back to the tile-clipped bbox centroid), which gave
// every tile a DIFFERENT label position per ocean — that's why "Atlantic
// Ocean" showed up two or three times near z=2 and sometimes drifted
// onto land. Baking polylabel at AOT means every clipped copy of a marine
// feature carries the same anchor, so OL's declutter pass dedups them
// automatically and the anchor is always inside the polygon (never on a
// peninsula). Vendored from Mapbox polylabel (ISC), priority queue
// inlined as sort-and-pop because perf isn't critical at build time.
function polylabel(geom, precision = 0.05) {
  let rings = null;
  if (geom.type === "Polygon") {
    rings = geom.coordinates;
  } else if (geom.type === "MultiPolygon") {
    // Pick the largest polygon component by signed-area magnitude — for
    // multi-island oceans (e.g. Atlantic + Caribbean inset) the label
    // belongs in the dominant water body.
    let bestArea = -1;
    for (const polyRings of geom.coordinates) {
      const a = Math.abs(plRingSignedArea(polyRings[0]));
      if (a > bestArea) { bestArea = a; rings = polyRings; }
    }
  }
  if (!rings || rings.length === 0) return null;

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of rings[0]) {
    if (p[0] < minX) minX = p[0];
    if (p[0] > maxX) maxX = p[0];
    if (p[1] < minY) minY = p[1];
    if (p[1] > maxY) maxY = p[1];
  }
  const w = maxX - minX, h = maxY - minY;
  const cellSize = Math.min(w, h);
  if (cellSize === 0) return [minX, minY];

  const half = cellSize / 2;
  const queue = [];
  for (let x = minX; x < maxX; x += cellSize) {
    for (let y = minY; y < maxY; y += cellSize) {
      queue.push(plMakeCell(x + half, y + half, half, rings));
    }
  }
  let best = plCentroidCell(rings);
  const bboxCenter = plMakeCell(minX + w / 2, minY + h / 2, 0, rings);
  if (bboxCenter.d > best.d) best = bboxCenter;

  // Cap iterations — Pacific-scale polygons can drag the search out and
  // we only need ~10 km accuracy for a label anchor.
  let iter = 0;
  while (queue.length && iter < 20000) {
    iter++;
    queue.sort((a, b) => a.max - b.max);
    const cell = queue.pop();
    if (cell.d > best.d) best = cell;
    if (cell.max - best.d <= precision) continue;
    const hh = cell.h / 2;
    queue.push(plMakeCell(cell.x - hh, cell.y - hh, hh, rings));
    queue.push(plMakeCell(cell.x + hh, cell.y - hh, hh, rings));
    queue.push(plMakeCell(cell.x - hh, cell.y + hh, hh, rings));
    queue.push(plMakeCell(cell.x + hh, cell.y + hh, hh, rings));
  }
  return [best.x, best.y];
}

function plMakeCell(x, y, h, rings) {
  const d = plPointToPolyDist(x, y, rings);
  return { x, y, h, d, max: d + h * Math.SQRT2 };
}

function plPointToPolyDist(x, y, rings) {
  let inside = false;
  let minSq = Infinity;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i], b = ring[j];
      if ((a[1] > y) !== (b[1] > y) &&
          x < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0]) {
        inside = !inside;
      }
      minSq = Math.min(minSq, plSegSqDist(x, y, a, b));
    }
  }
  return (inside ? 1 : -1) * Math.sqrt(minSq);
}

function plSegSqDist(px, py, a, b) {
  let x = a[0], y = a[1];
  let dx = b[0] - x, dy = b[1] - y;
  if (dx !== 0 || dy !== 0) {
    const t = ((px - x) * dx + (py - y) * dy) / (dx * dx + dy * dy);
    if (t > 1) { x = b[0]; y = b[1]; }
    else if (t > 0) { x += dx * t; y += dy * t; }
  }
  dx = px - x; dy = py - y;
  return dx * dx + dy * dy;
}

function plCentroidCell(rings) {
  let area = 0, cx = 0, cy = 0;
  const pts = rings[0];
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i], b = pts[j];
    const f = a[0] * b[1] - b[0] * a[1];
    cx += (a[0] + b[0]) * f;
    cy += (a[1] + b[1]) * f;
    area += f * 3;
  }
  if (area === 0) return plMakeCell(pts[0][0], pts[0][1], 0, rings);
  return plMakeCell(cx / area, cy / area, 0, rings);
}

function plRingSignedArea(ring) {
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    sum += (ring[j][0] - ring[i][0]) * (ring[j][1] + ring[i][1]);
  }
  return sum / 2;
}

// Land polygons: ne_50m_land has 1420 features — the continents are 5 of
// those, the next ~30 are Madagascar / Britain / Honshu / NZ / etc., and
// the long tail is 1300+ named islets sub-pixel at low zoom. Threshold
// gates them by area so the world tile contains continents + a handful of
// the largest islands instead of every reef.
function landMinZoomForArea(sr) {
  if (sr > 1e-3)   return 0;   // continents down to Sicily / Sri Lanka
  if (sr > 1e-4)   return 2;   // Jamaica-class
  if (sr > 1e-5)   return 4;
  if (sr > 1e-6)   return 5;
  return 6;
}

// Bathymetry polygons within a single band are NaturalEarth's broken-up
// seafloor topology — a 4000 m basin is one big polygon (e.g. central
// Pacific) plus dozens of smaller mid-ocean ridges and abyssal plains.
// Without an area gate the world tile was carrying 1500+ bathy_4000
// polygons, almost all sub-pixel. Same threshold curve as land — the few
// big ocean basins anchor the world view; the long tail of fragmented
// seafloor noise only appears when zoomed in enough to see it.
function bathyMinZoomForArea(sr) {
  if (sr > 1e-2)   return 0;   // ocean basin scale
  if (sr > 1e-3)   return 2;   // sub-basin
  if (sr > 1e-4)   return 3;
  if (sr > 1e-5)   return 5;
  return 6;
}

const CITIES_URL = "https://download.geonames.org/export/dump/cities500.zip";
// GeoNames admin1 codes → English names. "US.TX" → "Texas", "FR.11" →
// "Île-de-France", etc. We bake the admin1 name into each city's
// Wikipedia search string so disambiguating towns ("Paris, Texas") works
// without an extra runtime lookup.
const ADMIN1_URL = "https://download.geonames.org/export/dump/admin1CodesASCII.txt";

async function downloadCached(url, filename) {
  await fs.mkdir(CACHE_DIR, { recursive: true });
  const cachePath = path.join(CACHE_DIR, filename || path.basename(url));
  try {
    await fs.access(cachePath);
    return cachePath;
  } catch {}
  console.log("download", url);
  // Wikidata in particular blocks generic "node-fetch/" UAs. A browser-ish UA
  // gets us through; the contact email is the Wikimedia recommendation.
  // 502/504 are common on the SPARQL endpoint when a query runs long enough
  // to trip the nginx proxy timeout — a single retry after a short backoff
  // gets through most of the time.
  const attempts = 3;
  for (let i = 1; i <= attempts; i++) {
    let res;
    try {
      res = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 unfold-build (https://github.com/aymericbeaumet/unfold)",
          Accept: "application/json, application/geo+json, application/sparql-results+json, */*",
        },
      });
    } catch (err) {
      if (i === attempts) throw err;
      console.log(`  network error (${err.message}), retrying in ${i * 3}s …`);
      await new Promise((r) => setTimeout(r, i * 3000));
      continue;
    }
    if (res.ok) {
      const buf = Buffer.from(await res.arrayBuffer());
      await fs.writeFile(cachePath, buf);
      return cachePath;
    }
    if (i < attempts && (res.status === 429 || res.status >= 500)) {
      console.log(`  HTTP ${res.status}, retrying in ${i * 3}s …`);
      await new Promise((r) => setTimeout(r, i * 3000));
      continue;
    }
    throw new Error(`${url} → HTTP ${res.status}`);
  }
  throw new Error("unreachable");
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
      // Bake the pole-of-inaccessibility as feature properties so every
      // tile-clipped copy of "Atlantic Ocean" carries the same anchor.
      // Mercator metres (matches the runtime view projection) so the
      // marine style can read them straight into the geometry override.
      const anchor = polylabel(feature.geometry);
      if (anchor) {
        properties.labelX = lonToMercatorX(anchor[0]);
        properties.labelY = latToMercatorY(anchor[1]);
      }
    }
    if (source.class === "geo_region") {
      tipp.minzoom = geoRegionMinZoomForArea(geometryAreaSr(feature.geometry));
    }
    if (source.class === "lake") {
      tipp.minzoom = lakeMinZoomForArea(geometryAreaSr(feature.geometry));
    }
    if (source.class === "glacier") {
      tipp.minzoom = glacierMinZoomForArea(geometryAreaSr(feature.geometry));
    }
    if (source.class === "land") {
      tipp.minzoom = landMinZoomForArea(geometryAreaSr(feature.geometry));
    }
    if (source.class === "peak") {
      // NaturalEarth ships its own per-feature min_zoom; trust it.
      const z = feature.properties?.min_zoom;
      if (typeof z === "number") tipp.minzoom = Math.max(0, Math.min(PMTILES_MAX_ZOOM, Math.round(z)));
    }
    // Bathymetry LOD. Two stages of gating:
    //   1. Band-level: most depth bands only appear past z=5 so the ramp
    //      doesn't carry every 1000 m step at world / mid zoom. The z=3-4
    //      tiles were the slowest in the archive because too many bathy
    //      bands lit up there at once.
    //   2. Per-feature area: even the world-view bands hold a long tail of
    //      tiny mid-ocean ridges and abyssal plains that are sub-pixel at
    //      low zoom but were filling the z=0 tile with 1500+ polygons each.
    // Band schedule:
    //   • z 0–4: only 200 (shelf), 4000 (mid), 10000 (abyss). Three steps
    //     of gradient — enough to read "shallow / deep" at this scale.
    //   • z 5+: the full 11-band ramp comes in for fine resolution.
    // The area gate applies on top: even at world view, only the biggest
    // basin polygons render — the long tail of fragmented seafloor is
    // dropped. Re-run `npm run build-data` to bake.
    if (source.class && source.class.startsWith("bathy_")) {
      const depth = Number(source.class.split("_")[1]);
      const worldViewBand = depth === 200 || depth === 4000 || depth === 10000;
      const bandMinZoom = worldViewBand ? 0 : 5;
      const areaMinZoom = bathyMinZoomForArea(geometryAreaSr(feature.geometry));
      tipp.minzoom = Math.max(bandMinZoom, areaMinZoom);
      // Bathy maxZoom: keep the PMTiles archive under GitHub's 100 MB
      // limit. Deep bands disappear past mid zoom — at z>=7 the user is
      // close enough that the shallower band underneath still reads as
      // "this is deep ocean".
      if (depth >= 7000)      tipp.maxzoom = 6;
      else if (depth >= 4000) tipp.maxzoom = 7;
      else if (depth >= 2000) tipp.maxzoom = 8;
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

  // Stage paths grouped by MVT layer (multiple sources can feed the same
  // class — e.g. the two regional river_detail files).
  const byClass = new Map();
  for (const s of staged) {
    if (!byClass.has(s.class)) byClass.set(s.class, []);
    byClass.get(s.class).push(s.file);
  }
  const layerArgs = [];
  for (const [cls, files] of byClass) {
    // tippecanoe -L <name>:<file> accepts a single file per flag — repeat per
    // file with the same layer name and they merge.
    for (const f of files) layerArgs.push("-L", `${cls}:${f}`);
  }

  // -Z0 / -z PMTILES_MAX_ZOOM: zoom range. --simplification=12 is well above
  // the default — at low zoom the visible coastline only resolves to ~256 px
  // wide for the whole globe, so aggressive VW simplification cuts vertex
  // counts by ~3× without visible degradation. Per-feature tippecanoe.minzoom
  // / .maxzoom (set in stageBackgroundSource) handle LOD inside the archive;
  // the area-based gates on lake / glacier / land / marine / geo_region are
  // what keep the world tile from carrying every tiny pond and islet.
  // --coalesce-densest-as-needed merges adjacent features when a tile would
  // otherwise blow its size budget (better than dropping). We keep
  // --drop-densest-as-needed too: tippecanoe falls back to it when coalesce
  // can't recover enough space.
  const args = [
    "-o", out,
    "-f",                                     // overwrite existing archive
    "-Z", "0",                                // min zoom
    "-z", String(PMTILES_MAX_ZOOM),           // max zoom
    "--simplification=15",                    // Visvalingam-Whyatt tolerance
    "--coalesce-densest-as-needed",           // merge before dropping when over size budget
    "--drop-densest-as-needed",               // drop low-importance features when a tile is too big
    "--extend-zooms-if-still-dropping",       // bump zoom on the rare tile that still overflows
    "--no-tiny-polygon-reduction",            // keep small lakes from getting eaten
    ...layerArgs,
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

// Strip everything that isn't a letter/digit. Used to bake a
// punctuation-free version of each city's name into its search string
// so queries like "newyork" / "saintpaul" / "coteivoire" match
// "New York" / "Saint-Paul" / "Côte d'Ivoire" without needing the user
// to type the hyphen, space, or apostrophe.
function stripPunctuation(s) {
  return s.replace(/[^a-z0-9]/g, "");
}

async function buildCities() {
  const filePath = await downloadCached(CITIES_URL);
  const zip = await JSZip.loadAsync(await fs.readFile(filePath));
  const entry = zip.file("cities500.txt");
  if (!entry) throw new Error("cities500.txt missing from archive");
  const text = await entry.async("string");

  // Admin1 (state / region / province) → English name lookup. The file is
  // ~80 KB, one row per region: `<country>.<code>\t<name>\t<asciiName>\t<id>`.
  const admin1Path = await downloadCached(ADMIN1_URL);
  const admin1Map = new Map();
  for (const line of (await fs.readFile(admin1Path, "utf8")).split("\n")) {
    if (!line) continue;
    const cols = line.split("\t");
    if (cols.length >= 3) admin1Map.set(cols[0], cols[2] || cols[1]);
  }

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
    // Search string format:
    //   "<stripped-name> <normalized-name> <country-name> <country-code>"
    // The leading stripped-name (no spaces, hyphens, apostrophes) lets a
    // single-token query like "newyork" or "saintpaul" or "coteivoire"
    // match the name at the head of the string. The normalized name with
    // its original punctuation is still there so users typing "saint paul"
    // (two tokens) match by substring as well.
    const normalizedName = normalizeSearch(asciiName || name);
    const strippedName = stripPunctuation(normalizedName);
    return [strippedName, normalizedName, countrySearchString(country), country.toLowerCase()]
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
    const admin1Code = cols[10] || "";
    const population = parseInt(cols[14], 10) || 0;
    let score = population;
    if (featureCode === "PPLC") score += 1_000_000_000;
    else if (featureCode === "PPLA") score += 100_000_000;
    const lon = parseFloat(cols[5]);
    const lat = parseFloat(cols[4]);
    const name = cols[1];
    const flag = flagEmoji(country);
    const display = `${flag ? flag + " " : ""}${name}, ${countryDisplayName(country)}`;
    // Wikipedia search string. For US cities we include the state so
    // "Paris, Texas, United States" disambiguates against Paris, France.
    // For every other country we use just "City, Country" — the per-
    // user pref is that non-US admin1 names ("Île-de-France" etc.) read
    // as noise on the Wikipedia search row rather than disambiguation.
    const adminName = (country === "US" && admin1Code)
      ? admin1Map.get(`${country}.${admin1Code}`) || ""
      : "";
    const wiki = adminName
      ? `${name}, ${adminName}, ${countryDisplayName(country)}`
      : `${name}, ${countryDisplayName(country)}`;
    cities.push({
      name,
      country,
      population,
      isCapital: featureCode === "PPLC" ? 1 : 0,
      x: lonToMercatorX(lon),
      y: latToMercatorY(lat),
      score,
      display,
      wiki,
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

  // After the score sort, all capitals (PPLC) come first because of the
  // +1B score boost. The boundary lets the worker emit them as a hard-
  // floor "always show" set, independent of bbox or zoom.
  const capitalCount = cities.findIndex((c) => !c.isCapital);
  const capitals = capitalCount === -1 ? cities.length : capitalCount;
  console.log(`${capitals} capitals (PPLC) at the head of the score-sorted list`);

  const count = cities.length;
  const enc = new TextEncoder();
  const nameBytes = cities.map((c) => enc.encode(c.name));
  const displayBytes = cities.map((c) => enc.encode(c.display));
  const searchBytes = cities.map((c) => enc.encode(c.search));
  const wikiBytes = cities.map((c) => enc.encode(c.wiki));
  const totalNameBytes = nameBytes.reduce((acc, b) => acc + b.length, 0);
  const totalDisplayBytes = displayBytes.reduce((acc, b) => acc + b.length, 0);
  const totalSearchBytes = searchBytes.reduce((acc, b) => acc + b.length, 0);
  const totalWikiBytes = wikiBytes.reduce((acc, b) => acc + b.length, 0);

  // Header bumped from 13 → 14: appended capitalCount so the worker can
  // separate "always show" capitals from the score-ranked tail without
  // scanning. The new field sits at the end of the header so older
  // workers reading the old 13-field layout would still interpret the
  // first 13 fields correctly (the worker ships with the new bin via
  // Parcel hashing so this is belt-and-braces).
  const HEADER_FIELDS = 14;
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
  const wikiOffsetsOff = pad4(searchesOff + totalSearchBytes);
  const wikisOff = wikiOffsetsOff + (count + 1) * 4;
  const totalSize = pad4(wikisOff + totalWikiBytes);

  const buf = new ArrayBuffer(totalSize);
  const header = new Uint32Array(buf, 0, HEADER_FIELDS);
  header.set([
    count,
    xsOff, ysOff, popsOff,
    nameOffsetsOff, namesOff,
    displayOffsetsOff, displaysOff,
    searchOffsetsOff, searchesOff,
    wikiOffsetsOff, wikisOff,
    totalSize,
    capitals,
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
  const wikiOffsets = new Uint32Array(buf, wikiOffsetsOff, count + 1);
  const wikis = new Uint8Array(buf, wikisOff, totalWikiBytes);

  let nameCursor = 0;
  let displayCursor = 0;
  let searchCursor = 0;
  let wikiCursor = 0;
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

    wikiOffsets[i] = wikiCursor;
    wikis.set(wikiBytes[i], wikiCursor);
    wikiCursor += wikiBytes[i].length;
  }
  nameOffsets[count] = nameCursor;
  displayOffsets[count] = displayCursor;
  searchOffsets[count] = searchCursor;
  wikiOffsets[count] = wikiCursor;

  const out = path.join(OUT_DIR, "cities.bin");
  await fs.writeFile(out, Buffer.from(buf));
  console.log(`wrote ${count} cities → ${path.relative(__dirname, out)} (${(buf.byteLength / 1024 / 1024).toFixed(2)} MB)`);
}

// Generic point-dataset packer. Items are { x, y, score, zoom, label, meta }.
// `meta` is an arbitrary JSON-encodable object (the renderer JSON.parses it
// once on hover to build a popover). Items are sorted by descending score
// before packing so the runtime worker can scan in priority order.
async function buildPointsBin(filename, items, label) {
  const sorted = items
    .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y))
    .sort((a, b) => (b.score || 0) - (a.score || 0));
  const count = sorted.length;

  const enc = new TextEncoder();
  const labelBytes = sorted.map((p) => enc.encode(p.label || ""));
  const metaBytes = sorted.map((p) => enc.encode(p.meta ? JSON.stringify(p.meta) : ""));
  const totalLabelBytes = labelBytes.reduce((acc, b) => acc + b.length, 0);
  const totalMetaBytes = metaBytes.reduce((acc, b) => acc + b.length, 0);

  const HEADER_FIELDS = 10;
  const headerSize = HEADER_FIELDS * 4;
  const pad4 = (n) => (n + 3) & ~3;

  const xsOff = headerSize;
  const ysOff = xsOff + count * 4;
  const scoresOff = ysOff + count * 4;
  const zoomsOff = scoresOff + count * 4;
  const labelOffsetsOff = pad4(zoomsOff + count);
  const labelsOff = labelOffsetsOff + (count + 1) * 4;
  const metaOffsetsOff = pad4(labelsOff + totalLabelBytes);
  const metasOff = metaOffsetsOff + (count + 1) * 4;
  const totalSize = pad4(metasOff + totalMetaBytes);

  const buf = new ArrayBuffer(totalSize);
  const header = new Uint32Array(buf, 0, HEADER_FIELDS);
  header.set([
    count,
    xsOff, ysOff,
    scoresOff, zoomsOff,
    labelOffsetsOff, labelsOff,
    metaOffsetsOff, metasOff,
    totalSize,
  ]);

  const xs = new Float32Array(buf, xsOff, count);
  const ys = new Float32Array(buf, ysOff, count);
  const scores = new Uint32Array(buf, scoresOff, count);
  const zooms = new Uint8Array(buf, zoomsOff, count);
  const labelOffs = new Uint32Array(buf, labelOffsetsOff, count + 1);
  const labels = new Uint8Array(buf, labelsOff, totalLabelBytes);
  const metaOffs = new Uint32Array(buf, metaOffsetsOff, count + 1);
  const metas = new Uint8Array(buf, metasOff, totalMetaBytes);

  let lc = 0, mc = 0;
  for (let i = 0; i < count; i++) {
    const p = sorted[i];
    xs[i] = p.x;
    ys[i] = p.y;
    scores[i] = Math.max(0, Math.min(0xffffffff, Math.floor(p.score || 0)));
    zooms[i] = Math.max(0, Math.min(22, Math.floor(p.zoom || 0)));
    labelOffs[i] = lc;
    labels.set(labelBytes[i], lc);
    lc += labelBytes[i].length;
    metaOffs[i] = mc;
    metas.set(metaBytes[i], mc);
    mc += metaBytes[i].length;
  }
  labelOffs[count] = lc;
  metaOffs[count] = mc;

  const out = path.join(OUT_DIR, filename);
  await fs.writeFile(out, Buffer.from(buf));
  console.log(`wrote ${count} ${label} → ${path.relative(__dirname, out)} (${(buf.byteLength / 1024 / 1024).toFixed(2)} MB)`);
}

// --- Smithsonian volcanoes (Holocene) ---------------------------------------

const SMITHSONIAN_URL =
  "https://webservices.volcano.si.edu/geoserver/GVP-VOTW/ows" +
  "?service=WFS&version=1.0.0&request=GetFeature" +
  "&typeName=GVP-VOTW:Smithsonian_VOTW_Holocene_Volcanoes" +
  "&outputFormat=json";

async function buildVolcanoes() {
  const filePath = await downloadCached(SMITHSONIAN_URL, "smithsonian_volcanoes.geojson");
  const fc = JSON.parse(await fs.readFile(filePath, "utf8"));
  const items = [];
  for (const f of fc.features || []) {
    const [lon, lat] = f.geometry?.coordinates || [];
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    const p = f.properties || {};
    const name = p.Volcano_Name || "Unknown volcano";
    const elev = Number(p.Elevation) || 0;
    const lastEruption = Number(p.Last_Eruption_Year);
    // Score: composite stratovolcanoes 6000m up dominate the world view; a
    // 200m cinder cone with no recorded eruption only earns ink at deep zooms.
    const recencyBonus = Number.isFinite(lastEruption)
      ? Math.max(0, 2025 - lastEruption < 200 ? 5000 : (2025 - lastEruption < 2000 ? 2000 : 500))
      : 0;
    const score = Math.max(0, elev) + recencyBonus;
    // Bigger / more recent = visible earlier. Tighter than before — only
    // the tallest cones (≥4000 m) earn ink at world view; everything else
    // waits until the user zooms in enough that the icons aren't a soup.
    const zoom = elev >= 4500 ? 3 : elev >= 3000 ? 5 : elev >= 1500 ? 6 : 7;
    items.push({
      x: lonToMercatorX(lon),
      y: latToMercatorY(lat),
      score,
      zoom,
      label: name,
      meta: {
        elev,
        type: p.Primary_Volcano_Type || "",
        last: Number.isFinite(lastEruption) ? lastEruption : null,
        country: p.Country || "",
      },
    });
  }
  await buildPointsBin("volcanoes.bin", items, "volcanoes");
}

// --- Wikidata SPARQL --------------------------------------------------------

const WIKIDATA_ENDPOINT = "https://query.wikidata.org/sparql";

async function sparql(query, cacheKey) {
  const url = `${WIKIDATA_ENDPOINT}?query=${encodeURIComponent(query)}`;
  const filePath = await downloadCached(url, `wikidata_${cacheKey}.json`);
  const json = JSON.parse(await fs.readFile(filePath, "utf8"));
  return json.results?.bindings || [];
}

// Parse a Wikidata coord literal "Point(lon lat)".
function parseWdPoint(s) {
  const m = /Point\(\s*(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s*\)/.exec(s || "");
  if (!m) return null;
  return [Number(m[1]), Number(m[2])];
}

// Pluck the QID out of an `item` URI like `http://www.wikidata.org/entity/Q42`.
// We store the QID (not the full URI) in meta — saves bytes and lets the
// renderer build a Wikidata `Special:GoToLinkedPage` link that jumps to
// the matching English Wikipedia article in one redirect.
function parseQid(uri) {
  if (!uri) return null;
  const m = /\/(Q\d+)$/.exec(uri);
  return m ? m[1] : null;
}

// Wikidata seamounts (Q503269 — "mountain rising from the ocean floor that
// does not reach the water's surface"). The earlier QID Q207326 was
// actually "summit" / mountain top, so the bin filled with Mont Blanc and
// Everest. There are only ~530 notable seamounts with coordinates so we
// don't bother with a sitelinks filter.
async function buildSeamounts() {
  const query = `
    SELECT ?item ?itemLabel ?coord ?sitelinks WHERE {
      ?item wdt:P31/wdt:P279* wd:Q503269;
            wdt:P625 ?coord.
      OPTIONAL { ?item wikibase:sitelinks ?sitelinks. }
      SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
    }
  `;
  const rows = await sparql(query, "seamounts");
  const items = [];
  for (const r of rows) {
    const pt = parseWdPoint(r.coord?.value);
    if (!pt) continue;
    const sitelinks = Number(r.sitelinks?.value) || 0;
    const label = r.itemLabel?.value || "";
    if (!label || /^Q\d+$/.test(label)) continue; // unlabelled stubs
    items.push({
      x: lonToMercatorX(pt[0]),
      y: latToMercatorY(pt[1]),
      score: sitelinks,
      // Famous seamounts (Loihi, Bowie, Davidson) earn ink at higher zoom;
      // the long tail only fades in at street-level zoom so the world view
      // stays uncluttered.
      zoom: sitelinks >= 30 ? 4 : sitelinks >= 12 ? 6 : sitelinks >= 5 ? 7 : 8,
      label,
      meta: { qid: parseQid(r.item?.value) },
    });
  }
  await buildPointsBin("seamounts.bin", items, "seamounts");
}

// Wikidata megalithic monuments. The combined VALUES + P279* form trips
// Wikidata's 60s SPARQL timeout (the planner blows up), so we query each
// type separately and union the results. Each per-type query is small and
// finishes in well under a second.
// Verified QIDs (the earlier set was guessed and mostly resolved to
// unrelated entities: Q40080 is "beach", Q207565 is "1946 Florida
// hurricane", etc., which is how 17k beach-district names ended up in
// megaliths.bin). Each of these is a megalith-type root from a Wikidata
// search for the canonical English term.
const MEGALITH_TYPES = [
  { qid: "Q164240",   label: "megalith"        }, // megalith (umbrella)
  { qid: "Q101659",   label: "dolmen"          },
  { qid: "Q193475",   label: "menhir"          },
  { qid: "Q1935728",  label: "stone circle"    },
  { qid: "Q1426772",  label: "passage grave"   },
  { qid: "Q10521078", label: "megalithic tomb" },
  { qid: "Q34023",    label: "tumulus"         },
  { qid: "Q7321974",  label: "cairn"           },
];

async function buildMegaliths() {
  const items = [];
  const seen = new Set();
  for (const t of MEGALITH_TYPES) {
    const query = `
      SELECT ?item ?itemLabel ?coord ?sitelinks WHERE {
        ?item wdt:P31/wdt:P279* wd:${t.qid};
              wdt:P625 ?coord.
        OPTIONAL { ?item wikibase:sitelinks ?sitelinks. }
        SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
      }
    `;
    let rows;
    try {
      rows = await sparql(query, `megaliths_${t.qid}`);
    } catch (err) {
      console.warn(`  megalith type ${t.label} (${t.qid}) failed:`, err.message);
      continue;
    }
    console.log(`  ${t.label}: ${rows.length} rows`);
    for (const r of rows) {
      const pt = parseWdPoint(r.coord?.value);
      if (!pt) continue;
      const label = r.itemLabel?.value || "";
      if (!label || /^Q\d+$/.test(label)) continue;
      const key = `${pt[0].toFixed(5)},${pt[1].toFixed(5)}|${label}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const sitelinks = Number(r.sitelinks?.value) || 0;
      items.push({
        x: lonToMercatorX(pt[0]),
        y: latToMercatorY(pt[1]),
        score: sitelinks + 1,
        // Stonehenge / Newgrange first; the local dolmen down the lane
        // only at the deepest zoom. Without this gate the world view fills
        // with thousands of indistinguishable rings.
        zoom: sitelinks >= 80 ? 4 : sitelinks >= 25 ? 6 : sitelinks >= 5 ? 7 : 8,
        label,
        meta: { type: t.label, qid: parseQid(r.item?.value) },
      });
    }
  }
  await buildPointsBin("megaliths.bin", items, "megaliths");
}

// Wikidata historical events with coords + date. The query is broken into
// several smaller per-class queries because a single SELECT over the entire
// event class blows the SPARQL timeout. Results are unioned and de-duped.
//
// Each category gets its own emoji prefix in the label so the runtime style
// can give battles, treaties, expeditions, etc. visually distinct glyphs.
// Verified QIDs. The previous list mostly resolved to unrelated entities
// (Q40231 is "public election", Q12061 is "Tahrir Square", etc.), so the
// "Eruption" / "Expedition" rows in facts.bin earlier were elections and a
// single square. Re-derived via Wikidata's canonical English term search.
// Pre-modern history only — we cap events at year 1800 below, so anything
// after that is removed even if the category fires. Earthquake / natural
// disaster category was dropped (mostly 19th–21st-c. events that don't
// belong on a period-styled map).
const FACT_CATEGORIES = [
  { qid: "Q178561",    prefix: "⚔",  label: "Battle"     },  // battle
  { qid: "Q188055",    prefix: "⛓",  label: "Siege"      },  // siege
  { qid: "Q625298",    prefix: "🕊", label: "Treaty"     },  // peace treaty
  { qid: "Q906512",    prefix: "⚓", label: "Wreck"      },  // shipwrecking event
  { qid: "Q2401485",   prefix: "🧭", label: "Expedition" },  // expedition
  { qid: "Q7692360",   prefix: "🌋", label: "Eruption"   },  // volcanic eruption
  { qid: "Q124734",    prefix: "🗡", label: "Rebellion"  },  // rebellion
  { qid: "Q13418847",  prefix: "✶",  label: "Event"      },  // historical event
];

// Period cut-off — anything in 1800 CE or later is excluded. Keeps the map
// firmly in the era the visual language is calibrated for.
const FACT_MAX_YEAR_EXCLUSIVE = 1800;

async function buildFacts() {
  const items = [];
  const seen = new Set();
  for (const cat of FACT_CATEGORIES) {
    const query = `
      SELECT ?item ?itemLabel ?coord ?date ?sitelinks WHERE {
        ?item wdt:P31/wdt:P279* wd:${cat.qid};
              wdt:P625 ?coord;
              wdt:P585 ?date.
        ?item wikibase:sitelinks ?sitelinks.
        FILTER (?sitelinks >= 5)
        SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
      }
      LIMIT 30000
    `;
    let rows;
    try {
      rows = await sparql(query, `facts_${cat.qid}`);
    } catch (err) {
      console.warn(`fact category ${cat.qid} (${cat.label}) failed:`, err.message);
      continue;
    }
    console.log(`  ${cat.label}: ${rows.length} rows`);
    for (const r of rows) {
      const pt = parseWdPoint(r.coord?.value);
      if (!pt) continue;
      const label = r.itemLabel?.value || "";
      if (!label || /^Q\d+$/.test(label)) continue;
      const date = r.date?.value || "";
      // ISO 8601 year is the first run of digits (handle BCE "-0044" too).
      const ym = /^(-?\d+)/.exec(date);
      if (!ym) continue;
      const year = Number(ym[1]);
      if (!Number.isFinite(year)) continue;
      if (year >= FACT_MAX_YEAR_EXCLUSIVE) continue;
      const sitelinks = Number(r.sitelinks?.value) || 0;
      const key = `${pt[0].toFixed(4)},${pt[1].toFixed(4)}|${label}|${year}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({
        x: lonToMercatorX(pt[0]),
        y: latToMercatorY(pt[1]),
        score: sitelinks,
        // Higher bar for low-zoom appearance — only iconic events at world
        // view (Thermopylae, Hastings, Lepanto). Local skirmishes only at
        // deep zoom so the map stays scannable.
        zoom: sitelinks >= 120 ? 3 : sitelinks >= 60 ? 5 : sitelinks >= 25 ? 6 : 7,
        label: `${cat.prefix} ${label}`,
        meta: { y: year, k: cat.label, qid: parseQid(r.item?.value) },
      });
    }
  }
  await buildPointsBin("facts.bin", items, "facts");
}

// Wikidata caves (Q35509 — natural underground hollow). The Wikipedia
// sitelinks filter trims unfamous holes; we still keep the tail at z 7+ so
// regional caverns surface once zoomed in.
async function buildCaves() {
  const query = `
    SELECT ?item ?itemLabel ?coord ?sitelinks WHERE {
      ?item wdt:P31/wdt:P279* wd:Q35509;
            wdt:P625 ?coord.
      ?item wikibase:sitelinks ?sitelinks.
      FILTER (?sitelinks >= 3)
      SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
    }
    LIMIT 8000
  `;
  let rows;
  try {
    rows = await sparql(query, "caves");
  } catch (err) {
    console.warn("  caves SPARQL failed:", err.message);
    return;
  }
  console.log(`  caves: ${rows.length} rows`);
  const items = [];
  const seen = new Set();
  for (const r of rows) {
    const pt = parseWdPoint(r.coord?.value);
    if (!pt) continue;
    const label = r.itemLabel?.value || "";
    if (!label || /^Q\d+$/.test(label)) continue;
    const key = `${pt[0].toFixed(4)},${pt[1].toFixed(4)}|${label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const sitelinks = Number(r.sitelinks?.value) || 0;
    items.push({
      x: lonToMercatorX(pt[0]),
      y: latToMercatorY(pt[1]),
      score: sitelinks,
      // Mammoth, Carlsbad, Postojna early; the local karst pothole only
      // at deep zoom so the map doesn't speckle.
      zoom: sitelinks >= 40 ? 4 : sitelinks >= 15 ? 6 : 7,
      label,
      meta: { qid: parseQid(r.item?.value) },
    });
  }
  await buildPointsBin("caves.bin", items, "caves");
}

// Wikidata castles (Q23413). There are many — the sitelinks gate keeps
// the bin focused on famous ones (Neuschwanstein, Edinburgh, Krak des
// Chevaliers, …) while still surfacing regional examples by mid zoom.
async function buildCastles() {
  const query = `
    SELECT ?item ?itemLabel ?coord ?sitelinks WHERE {
      ?item wdt:P31/wdt:P279* wd:Q23413;
            wdt:P625 ?coord.
      ?item wikibase:sitelinks ?sitelinks.
      FILTER (?sitelinks >= 5)
      SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
    }
    LIMIT 20000
  `;
  let rows;
  try {
    rows = await sparql(query, "castles");
  } catch (err) {
    console.warn("  castles SPARQL failed:", err.message);
    return;
  }
  console.log(`  castles: ${rows.length} rows`);
  const items = [];
  const seen = new Set();
  for (const r of rows) {
    const pt = parseWdPoint(r.coord?.value);
    if (!pt) continue;
    const label = r.itemLabel?.value || "";
    if (!label || /^Q\d+$/.test(label)) continue;
    const key = `${pt[0].toFixed(4)},${pt[1].toFixed(4)}|${label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const sitelinks = Number(r.sitelinks?.value) || 0;
    items.push({
      x: lonToMercatorX(pt[0]),
      y: latToMercatorY(pt[1]),
      score: sitelinks,
      // Neuschwanstein / Tower of London / Krak / Edinburgh first at z 3,
      // then regional fortresses, then ruined keeps.
      zoom: sitelinks >= 80 ? 3 : sitelinks >= 30 ? 5 : sitelinks >= 12 ? 6 : 7,
      label,
      meta: { qid: parseQid(r.item?.value) },
    });
  }
  await buildPointsBin("castles.bin", items, "castles");
}

await fs.mkdir(OUT_DIR, { recursive: true });

// Each dataset is independent; an upstream blip on one shouldn't kill the
// whole build. Wrap each in a guard that reports the failure but keeps the
// others running, so a flaky Wikidata response doesn't lose us a fresh
// tippecanoe pass.
async function safe(name, fn) {
  try {
    await fn();
  } catch (err) {
    console.error(`✗ ${name} failed:`, err.message);
  }
}

// SKIP env var lets you re-run just the cheap point-dataset packers without
// paying the ~3-minute tippecanoe pass when the upstream NaturalEarth /
// PMTiles source hasn't changed. Set `SKIP=pmtiles npm run build-data`.
const skip = new Set((process.env.SKIP || "").split(",").map((s) => s.trim()).filter(Boolean));
const maybe = (name, fn) => skip.has(name) ? console.log(`skipping ${name}`) : safe(name, fn);

await Promise.all([
  maybe("pmtiles",   buildBackground),
  maybe("cities",    buildCities),
  maybe("volcanoes", buildVolcanoes),
  maybe("seamounts", buildSeamounts),
  maybe("megaliths", buildMegaliths),
  maybe("facts",     buildFacts),
  maybe("caves",     buildCaves),
  maybe("castles",   buildCastles),
]);
