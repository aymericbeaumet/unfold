#!/usr/bin/env node
// Downloads NaturalEarth + GeoNames source data and emits the two static
// files the web app consumes:
//   data/background.geojson  — merged background layers (land, water, etc.)
//   data/cities.bin          — cities sorted by score, packed binary
//
// The binary layout (little-endian) lets the worker map TypedArray views
// directly over the fetched ArrayBuffer with zero parse cost:
//   [u32]             count
//   [f32 * count]     lons
//   [f32 * count]     lats
//   [u32 * count+1]   cumulative name offsets (count+1 entries; last = total)
//   [u8  * total]     concatenated utf-8 name bytes

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(__dirname, ".data-cache");
const OUT_DIR = path.join(__dirname, "data");

const COORD_PRECISION = 3;
const CITY_COORD_PRECISION = 4;

const BACKGROUND_SOURCES = [
  ["bathymetry_deep", "https://d2ad6b4ur7yvpq.cloudfront.net/naturalearth-3.3.0/ne_10m_bathymetry_E_6000.geojson"],
  ["bathymetry_shallow", "https://d2ad6b4ur7yvpq.cloudfront.net/naturalearth-3.3.0/ne_10m_bathymetry_J_1000.geojson"],
  ["glacier", "https://d2ad6b4ur7yvpq.cloudfront.net/naturalearth-3.3.0/ne_50m_glaciated_areas.geojson"],
  ["lake", "https://d2ad6b4ur7yvpq.cloudfront.net/naturalearth-3.3.0/ne_10m_lakes.geojson"],
  ["land", "https://d2ad6b4ur7yvpq.cloudfront.net/naturalearth-3.3.0/ne_50m_land.geojson"],
  ["marine", "https://d2ad6b4ur7yvpq.cloudfront.net/naturalearth-3.3.0/ne_10m_geography_marine_polys.geojson"],
  ["river", "https://d2ad6b4ur7yvpq.cloudfront.net/naturalearth-3.3.0/ne_10m_rivers_europe.geojson"],
  ["river", "https://d2ad6b4ur7yvpq.cloudfront.net/naturalearth-3.3.0/ne_10m_rivers_north_america.geojson"],
  ["river", "https://d2ad6b4ur7yvpq.cloudfront.net/naturalearth-3.3.0/ne_50m_rivers_lake_centerlines_scale_rank.geojson"],
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
  for (const [featureClass, url] of BACKGROUND_SOURCES) {
    const filePath = await downloadCached(url);
    const fc = JSON.parse(await fs.readFile(filePath, "utf8"));
    for (const feature of fc.features) {
      const properties = { featureClass };
      const rawName = feature.properties?.name;
      if (typeof rawName === "string") {
        const name = titleCase(rawName);
        if (name) properties.name = name;
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

async function buildCities() {
  const filePath = await downloadCached(CITIES_URL);
  const zip = await JSZip.loadAsync(await fs.readFile(filePath));
  const entry = zip.file("cities500.txt");
  if (!entry) throw new Error("cities500.txt missing from archive");
  const text = await entry.async("string");

  const cities = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    const cols = line.split("\t");
    const featureCode = cols[7];
    const population = parseInt(cols[14], 10) || 0;
    let score = population;
    if (featureCode === "PPLC") score += 1_000_000_000;
    else if (featureCode === "PPLA") score += 100_000_000;
    cities.push({
      name: cols[1],
      lon: round(parseFloat(cols[5]), CITY_COORD_PRECISION),
      lat: round(parseFloat(cols[4]), CITY_COORD_PRECISION),
      score,
    });
  }
  cities.sort((a, b) => b.score - a.score);

  const count = cities.length;
  const enc = new TextEncoder();
  const nameBytes = cities.map((c) => enc.encode(c.name));
  const totalNameBytes = nameBytes.reduce((acc, b) => acc + b.length, 0);

  const headerSize = 4;
  const lonsSize = count * 4;
  const latsSize = count * 4;
  const offsetsSize = (count + 1) * 4;
  const buf = new ArrayBuffer(headerSize + lonsSize + latsSize + offsetsSize + totalNameBytes);

  const counts = new Uint32Array(buf, 0, 1);
  counts[0] = count;

  const lons = new Float32Array(buf, headerSize, count);
  const lats = new Float32Array(buf, headerSize + lonsSize, count);
  const offsets = new Uint32Array(buf, headerSize + lonsSize + latsSize, count + 1);
  const names = new Uint8Array(buf, headerSize + lonsSize + latsSize + offsetsSize);

  let cursor = 0;
  for (let i = 0; i < count; i++) {
    lons[i] = cities[i].lon;
    lats[i] = cities[i].lat;
    offsets[i] = cursor;
    names.set(nameBytes[i], cursor);
    cursor += nameBytes[i].length;
  }
  offsets[count] = cursor;

  const out = path.join(OUT_DIR, "cities.bin");
  await fs.writeFile(out, Buffer.from(buf));
  console.log(`wrote ${count} cities → ${path.relative(__dirname, out)} (${(buf.byteLength / 1024 / 1024).toFixed(2)} MB)`);
}

await fs.mkdir(OUT_DIR, { recursive: true });
await Promise.all([buildBackground(), buildCities()]);
