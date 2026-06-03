#!/usr/bin/env node
// Downloads NaturalEarth + GeoNames source data and emits the two static
// files the web app consumes:
//   data/background.geojson  — merged background layers (land, water, etc.)
//   data/cities.bin          — cities sorted by score, packed binary
//
// The binary layout (little-endian) lets the worker map TypedArray views
// directly over the fetched ArrayBuffer with zero parse cost.
//
// Header (10 × u32 = 40 bytes), each a byte offset into the buffer:
//   count, lonsOff, latsOff, popsOff, countriesOff,
//   nameOffsetsOff, namesOff, searchOffsetsOff, searchesOff, totalSize
//
// Sections (each starts at its declared offset, padded to 4 bytes):
//   [f32  * count]    lons
//   [f32  * count]    lats
//   [u32  * count]    populations
//   [u8   * 2*count]  ISO-3166-1 alpha-2 country codes (raw ASCII pair)
//   [u32  * count+1]  display-name end offsets (last = total bytes)
//   [u8   * total_d]  utf-8 display name bytes
//   [u32  * count+1]  search-string end offsets
//   [u8   * total_s]  normalized "name countryName countryCode" bytes

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(__dirname, ".data-cache");
const OUT_DIR = path.join(__dirname, "data");

const COORD_PRECISION = 3;
const CITY_COORD_PRECISION = 4;

// `keep` is an optional list of source-property keys to copy through (useful
// for level-of-detail decisions in the client, e.g. river scale_rank).
const BACKGROUND_SOURCES = [
  { class: "bathymetry_deep",    url: "https://d2ad6b4ur7yvpq.cloudfront.net/naturalearth-3.3.0/ne_10m_bathymetry_E_6000.geojson" },
  { class: "bathymetry_shallow", url: "https://d2ad6b4ur7yvpq.cloudfront.net/naturalearth-3.3.0/ne_10m_bathymetry_J_1000.geojson" },
  { class: "glacier",            url: "https://d2ad6b4ur7yvpq.cloudfront.net/naturalearth-3.3.0/ne_50m_glaciated_areas.geojson" },
  { class: "lake",               url: "https://d2ad6b4ur7yvpq.cloudfront.net/naturalearth-3.3.0/ne_10m_lakes.geojson" },
  { class: "land",               url: "https://d2ad6b4ur7yvpq.cloudfront.net/naturalearth-3.3.0/ne_50m_land.geojson" },
  { class: "marine",             url: "https://d2ad6b4ur7yvpq.cloudfront.net/naturalearth-3.3.0/ne_10m_geography_marine_polys.geojson" },
  // Regional high-detail rivers — only rendered at close zoom.
  { class: "river_detail",       url: "https://d2ad6b4ur7yvpq.cloudfront.net/naturalearth-3.3.0/ne_10m_rivers_europe.geojson" },
  { class: "river_detail",       url: "https://d2ad6b4ur7yvpq.cloudfront.net/naturalearth-3.3.0/ne_10m_rivers_north_america.geojson" },
  // Global rivers with scale_rank (1 = Amazon-class, 10 = creek) — LOD-filtered.
  { class: "river",              url: "https://d2ad6b4ur7yvpq.cloudfront.net/naturalearth-3.3.0/ne_50m_rivers_lake_centerlines_scale_rank.geojson", keep: ["scalerank"] },
];

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

function round(n, precision) {
  const m = 10 ** precision;
  return Math.round(n * m) / m;
}

function trimCoords(coords, precision) {
  if (typeof coords[0] === "number") {
    for (let i = 0; i < coords.length; i++) coords[i] = round(coords[i], precision);
    return;
  }
  for (const c of coords) trimCoords(c, precision);
}

function titleCase(s) {
  return s
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\S+/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase());
}

async function buildBackground() {
  const features = [];
  for (const source of BACKGROUND_SOURCES) {
    const filePath = await downloadCached(source.url);
    const fc = JSON.parse(await fs.readFile(filePath, "utf8"));
    for (const feature of fc.features) {
      const properties = { featureClass: source.class };
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
      feature.properties = properties;
      if (feature.geometry?.coordinates) {
        trimCoords(feature.geometry.coordinates, COORD_PRECISION);
      }
      features.push(feature);
    }
  }
  const out = path.join(OUT_DIR, "background.geojson");
  await fs.writeFile(out, JSON.stringify({ type: "FeatureCollection", features }));
  console.log(`wrote ${features.length} features → ${path.relative(__dirname, out)}`);
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
  const countryCache = new Map();
  function searchString(name, asciiName, country) {
    let cn = countryCache.get(country);
    if (cn === undefined) {
      const parts = [];
      try {
        const en = countryName.of(country);
        if (en) parts.push(normalizeSearch(en));
      } catch {}
      for (const alias of COUNTRY_ALIASES[country] || []) {
        parts.push(normalizeSearch(alias));
      }
      cn = parts.join(" ");
      countryCache.set(country, cn);
    }
    return [normalizeSearch(asciiName || name), cn, country.toLowerCase()]
      .filter(Boolean)
      .join(" ");
  }

  const cities = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    const cols = line.split("\t");
    const featureCode = cols[7];
    const country = (cols[8] || "  ").padEnd(2).slice(0, 2);
    const population = parseInt(cols[14], 10) || 0;
    let score = population;
    if (featureCode === "PPLC") score += 1_000_000_000;
    else if (featureCode === "PPLA") score += 100_000_000;
    cities.push({
      name: cols[1],
      country,
      population,
      lon: round(parseFloat(cols[5]), CITY_COORD_PRECISION),
      lat: round(parseFloat(cols[4]), CITY_COORD_PRECISION),
      score,
      search: searchString(cols[1], cols[2], country),
    });
  }
  cities.sort((a, b) => b.score - a.score);

  const count = cities.length;
  const enc = new TextEncoder();
  const nameBytes = cities.map((c) => enc.encode(c.name));
  const searchBytes = cities.map((c) => enc.encode(c.search));
  const totalNameBytes = nameBytes.reduce((acc, b) => acc + b.length, 0);
  const totalSearchBytes = searchBytes.reduce((acc, b) => acc + b.length, 0);

  const HEADER_FIELDS = 10;
  const headerSize = HEADER_FIELDS * 4;
  const pad4 = (n) => (n + 3) & ~3;

  const lonsOff = headerSize;
  const latsOff = lonsOff + count * 4;
  const popsOff = latsOff + count * 4;
  const countriesOff = popsOff + count * 4;
  const nameOffsetsOff = pad4(countriesOff + count * 2);
  const namesOff = nameOffsetsOff + (count + 1) * 4;
  const searchOffsetsOff = pad4(namesOff + totalNameBytes);
  const searchesOff = searchOffsetsOff + (count + 1) * 4;
  const totalSize = pad4(searchesOff + totalSearchBytes);

  const buf = new ArrayBuffer(totalSize);
  const header = new Uint32Array(buf, 0, HEADER_FIELDS);
  header.set([
    count,
    lonsOff, latsOff, popsOff, countriesOff,
    nameOffsetsOff, namesOff, searchOffsetsOff, searchesOff,
    totalSize,
  ]);

  const lons = new Float32Array(buf, lonsOff, count);
  const lats = new Float32Array(buf, latsOff, count);
  const pops = new Uint32Array(buf, popsOff, count);
  const countries = new Uint8Array(buf, countriesOff, count * 2);
  const nameOffsets = new Uint32Array(buf, nameOffsetsOff, count + 1);
  const names = new Uint8Array(buf, namesOff, totalNameBytes);
  const searchOffsets = new Uint32Array(buf, searchOffsetsOff, count + 1);
  const searches = new Uint8Array(buf, searchesOff, totalSearchBytes);

  let nameCursor = 0;
  let searchCursor = 0;
  for (let i = 0; i < count; i++) {
    lons[i] = cities[i].lon;
    lats[i] = cities[i].lat;
    pops[i] = cities[i].population;
    countries[i * 2] = cities[i].country.charCodeAt(0) || 32;
    countries[i * 2 + 1] = cities[i].country.charCodeAt(1) || 32;

    nameOffsets[i] = nameCursor;
    names.set(nameBytes[i], nameCursor);
    nameCursor += nameBytes[i].length;

    searchOffsets[i] = searchCursor;
    searches.set(searchBytes[i], searchCursor);
    searchCursor += searchBytes[i].length;
  }
  nameOffsets[count] = nameCursor;
  searchOffsets[count] = searchCursor;

  const out = path.join(OUT_DIR, "cities.bin");
  await fs.writeFile(out, Buffer.from(buf));
  console.log(`wrote ${count} cities → ${path.relative(__dirname, out)} (${(buf.byteLength / 1024 / 1024).toFixed(2)} MB)`);
}

await fs.mkdir(OUT_DIR, { recursive: true });
await Promise.all([buildBackground(), buildCities()]);
