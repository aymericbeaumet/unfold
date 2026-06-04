// The 400 normal weight is declared inline in index.html so it can be
// rel=preloaded before the JS bundle parses. Italics is the only variant
// still loaded via @fontsource (used by the loading-overlay status line).
import "@fontsource/im-fell-english/400-italic.css";

import VectorLayer from "ol/layer/Vector";
import VectorTileLayer from "ol/layer/VectorTile";
import VectorSource from "ol/source/Vector";
import VectorTileSource from "ol/source/VectorTile";
import Feature from "ol/Feature";
import Point from "ol/geom/Point";
import { Fill, Style, RegularShape, Text, Stroke, Circle as CircleStyle } from "ol/style";
import { MVT } from "ol/format";
// Aliased so the global `Map` (used for diffing visible cities below) isn't
// shadowed by OL's `Map` class.
import { View, Map as OLMap } from "ol";
import { fromLonLat, toLonLat } from "ol/proj";
import { PMTiles } from "pmtiles";

// `new URL(..., import.meta.url)` shares Parcel's asset pipeline with the
// `<link rel=preload>` tags in index.html, so the preload hash matches the
// runtime fetch hash and the browser de-dupes — the import.meta form is what
// Parcel statically rewrites to the same hashed path the HTML references.
const BACKGROUND_URL = new URL("./data/background.pmtiles", import.meta.url).href;
const CITIES_URL = new URL("./data/cities.bin", import.meta.url).href;

/* ── theme ─────────────────────────────────────────────────────────────── */

// Period-correct palette: every tone is a tea-stained variation of the
// rag-paper base. No blues, greys, or saturated colours — those don't exist
// in pre-1850 hand-coloured engravings.
const COLOR_INK = "#1d1206";
const COLOR_LAND = "#E0C9A6";
const COLOR_WATER = "#F0DEC2";
const COLOR_WATER_SHALLOW = "#D6C6AB";
const COLOR_WATER_DEEP = "#BDAE97";
const COLOR_GLACIER = "#F1E4C7";  // bone-white parchment, very slightly lighter than water
const COLOR_URBAN = "#C6A87C";    // built-up areas — a notch darker than land
const COLOR_ROAD = "#6B3F18";     // warm sepia line, distinct from the cooler ink of rivers

const MAX_VISIBLE_CITIES = 300;
const CITY_FADE_MS = 350;

// Web Mercator vertical extent (meters).
const MERCATOR_Y_MAX = 20037508.342789244;
// Full horizontal span of one Web Mercator world (2 × π × earthRadius).
const MERCATOR_WORLD = 2 * Math.PI * 6378137;

/* ── map ──────────────────────────────────────────────────────────────── */

// Hash format mirrors Google Maps: #@lat,lon,zoomz (lat first, comma-separated,
// trailing 'z' on the zoom). Copy a Google Maps URL into here and it just works.
function parseHash() {
  const m = /^#?@?(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)z?$/.exec(
    location.hash,
  );
  if (!m) return null;
  return { lat: Number(m[1]), lon: Number(m[2]), zoom: Number(m[3]) };
}

const initialHash = parseHash();

const mapElement = document.getElementById("map");

// The world fits the viewport vertically at zoom = log2(viewportHeight / 256)
// in EPSG:3857. Compute it from the DOM synchronously so the first paint
// already shows the whole-world view (no zoom-0 flash).
function viewportFitZoom() {
  const h = mapElement.clientHeight || window.innerHeight || 800;
  return Math.log2(h / 256);
}

const view = new View({
  center: initialHash
    ? fromLonLat([initialHash.lon, initialHash.lat])
    : fromLonLat([0, 20]),
  zoom: initialHash ? initialHash.zoom : viewportFitZoom(),
  // Lock the view inside the latitudinal extent of the map; horizontal pan
  // can run freely so the wrapX sources below can repeat the world. Hard-stop
  // at the top/bottom edges and at the min/max zoom — no rubber-band.
  extent: [-Infinity, -MERCATOR_Y_MAX, Infinity, MERCATOR_Y_MAX],
  constrainOnlyCenter: false,
  smoothExtentConstraint: false,
  smoothResolutionConstraint: false,
});

const map = new OLMap({
  target: mapElement,
  controls: [],
  view,
});

mapElement.style.backgroundColor = COLOR_WATER;

// Dynamic min-zoom: never let the map be vertically smaller than the viewport.
function applyMinZoom() {
  const size = map.getSize();
  if (!size) return;
  const maxRes = (2 * MERCATOR_Y_MAX) / size[1];
  const minZoom = view.getZoomForResolution(maxRes);
  view.setMinZoom(minZoom);
  if (view.getZoom() < minZoom) view.setZoom(minZoom);
}
map.once("postrender", applyMinZoom);
window.addEventListener("resize", applyMinZoom);

// Reflect the view in location.hash. Debounced because moveend can fire
// many times during an animation; we only want one history entry's worth.
let hashTimer = 0;
function writeHash() {
  const center = view.getCenter();
  const zoom = view.getZoom();
  if (!center || zoom == null) return;
  const [lon, lat] = toLonLat(center);
  const next = `#@${lat.toFixed(7)},${lon.toFixed(7)},${zoom.toFixed(1)}z`;
  if (next !== location.hash) {
    history.replaceState(null, "", next);
  }
}
map.on("moveend", () => {
  clearTimeout(hashTimer);
  hashTimer = setTimeout(writeHash, 150);
});

// Cross-tab / back-button updates: re-sync from the hash.
window.addEventListener("hashchange", () => {
  const h = parseHash();
  if (!h) return;
  view.animate({
    center: fromLonLat([h.lon, h.lat]),
    zoom: h.zoom,
    duration: 0,
  });
});

/* ── background layer ─────────────────────────────────────────────────── */

// All styles are constructed once and reused. The style function dispatches
// on the MVT layer name (`feature.get('featureClass')` is set by MVT's
// `layerName` option below) — no string switching on a property, no per-zoom
// resolution checks (river LOD is baked into the tile contents via
// per-feature tippecanoe.minzoom).
function backgroundLayerStyle() {
  const bathymetry_shallow = new Style({
    zIndex: 100,
    fill: new Fill({ color: COLOR_WATER_SHALLOW }),
  });
  const bathymetry_deep = new Style({
    zIndex: 200,
    fill: new Fill({ color: COLOR_WATER_DEEP }),
  });
  const land = [
    new Style({ zIndex: 301, stroke: new Stroke({ color: COLOR_INK, width: 31 }) }),
    new Style({ zIndex: 302, stroke: new Stroke({ color: COLOR_WATER, width: 30 }) }),
    new Style({ zIndex: 303, stroke: new Stroke({ color: COLOR_INK, width: 21 }) }),
    new Style({ zIndex: 304, stroke: new Stroke({ color: COLOR_WATER, width: 20 }) }),
    new Style({ zIndex: 305, stroke: new Stroke({ color: COLOR_INK, width: 15 }) }),
    new Style({ zIndex: 306, stroke: new Stroke({ color: COLOR_WATER, width: 14 }) }),
    new Style({ zIndex: 307, stroke: new Stroke({ color: COLOR_INK, width: 9 }) }),
    new Style({ zIndex: 308, stroke: new Stroke({ color: COLOR_WATER, width: 8 }) }),
    new Style({ zIndex: 309, stroke: new Stroke({ color: COLOR_INK, width: 3 }) }),
    new Style({ zIndex: 310, fill: new Fill({ color: COLOR_LAND }) }),
  ];
  // Marine labels: with wrapX=true the source renders into every world copy
  // intersecting the viewport, which made labels like "Arctic Ocean" appear
  // twice near z=1. The geometry function pulls the label into the world
  // copy nearest view center on every wrapped rendering, so they all land at
  // the same absolute position and declutter dedupes them down to one.
  const marinePoint = new Point([0, 0]);
  const marine = new Style({
    zIndex: 400,
    geometry: (feature) => {
      // Use the polygon's INTERIOR POINT (always inside the water body) so
      // a Mediterranean-style label can't end up sitting on land just
      // because the polygon's axis-aligned bbox midpoint happens to fall on
      // a peninsula. Polygon and MultiPolygon expose different methods, and
      // MVT can hand us either, so handle both with a fall-back to the
      // extent centroid.
      const geom = feature.getGeometry();
      let fx, fy;
      if (typeof geom.getInteriorPoint === "function") {
        const p = geom.getInteriorPoint().getCoordinates();
        fx = p[0]; fy = p[1];
      } else if (typeof geom.getInteriorPoints === "function") {
        const flat = geom.getInteriorPoints().getFlatCoordinates();
        fx = flat[0]; fy = flat[1];
      } else {
        const [minX, minY, maxX, maxY] = geom.getExtent();
        fx = (minX + maxX) / 2; fy = (minY + maxY) / 2;
      }
      const viewCenter = view.getCenter();
      const cx = viewCenter ? viewCenter[0] : 0;
      // Snap fx to the world-copy translation that minimises distance to cx
      // — same dedup trick that stops "Arctic Ocean" from showing twice.
      const shifts = Math.round((cx - fx) / MERCATOR_WORLD);
      marinePoint.setCoordinates([fx + shifts * MERCATOR_WORLD, fy]);
      return marinePoint;
    },
    text: new Text({
      fill: new Fill({ color: COLOR_INK }),
      font: 'bold 18px "IM Fell English"',
    }),
  });
  const glacier = new Style({
    zIndex: 500,
    fill: new Fill({ color: COLOR_GLACIER }),
    stroke: new Stroke({ color: COLOR_INK, width: 0.6 }),
  });
  const river = new Style({ zIndex: 600, stroke: new Stroke({ color: COLOR_INK, width: 1 }) });
  const lake = new Style({
    zIndex: 700,
    fill: new Fill({ color: COLOR_WATER }),
    stroke: new Stroke({ color: COLOR_INK, width: 1 }),
  });
  // Drawable city footprint — a darker tea-stain over the land so users can
  // see where to colour their towns. Light ink outline so it reads as a
  // delineation, not a smudge.
  const urban_area = new Style({
    zIndex: 750,
    fill: new Fill({ color: COLOR_URBAN }),
    stroke: new Stroke({ color: COLOR_INK, width: 0.5 }),
  });
  // Old-road style: a thin double line — a darker carriageway base with a
  // slightly lighter centerline gives the engraved post-road look.
  const road = [
    new Style({ zIndex: 800, stroke: new Stroke({ color: COLOR_ROAD, width: 1.6 }) }),
    new Style({ zIndex: 801, stroke: new Stroke({ color: COLOR_WATER, width: 0.5, lineDash: [4, 3] }) }),
  ];
  // Sea route (NaturalEarth ferries) — period-style dashed sepia, thinner
  // than a road and drawn over the water without a centerline. Renders just
  // below the road layer so coastal roads draw cleanly over the dashes.
  const seaRoute = new Style({
    zIndex: 780,
    stroke: new Stroke({ color: COLOR_ROAD, width: 1, lineDash: [3, 4] }),
  });
  // Mountain peaks: upward-pointing triangle (the period-correct mountain
  // pictograph) tinted by elevation. The colour ramps from warm-sand at sea
  // level to near-black at 8000 m+ — the visual cue that "darker = higher"
  // mimics the engraved hachure-shading of antique maps. Triangle radius
  // also grows with elevation so a Himalayan giant overshadows a foothill.
  // Styles are cached per 1 km elevation tier so the style function isn't
  // re-allocating on every tile render.
  const PEAK_LABEL_MIN_ZOOM = 5;
  const peakStyleCache = new Map();
  function peakDotStyle(elev) {
    const tier = Math.max(0, Math.min(8, Math.floor((elev || 0) / 1000)));
    const cached = peakStyleCache.get(tier);
    if (cached) return cached;
    // Linear ramp from #C6A87C (warm tan) at tier 0 to #1d1206 (ink) at tier 8.
    const t = tier / 8;
    const lerp = (a, b) => Math.round(a + (b - a) * t);
    const fill = new Fill({
      color: `rgb(${lerp(0xC6, 0x1d)}, ${lerp(0xA8, 0x12)}, ${lerp(0x7C, 0x06)})`,
    });
    const stroke = new Stroke({ color: COLOR_LAND, width: 0.5 });
    const shape = new RegularShape({
      points: 3,
      radius: 5 + tier * 0.7,             // 5 px at sea level → ~10.6 px at 8 km
      angle: 0,
      fill,
      stroke,
    });
    const style = new Style({
      // Higher peaks paint over shorter neighbours.
      zIndex: 850 + tier,
      image: shape,
      declutterMode: "none",
    });
    peakStyleCache.set(tier, style);
    return style;
  }
  // Label fill/stroke are shared (one Fill per ramp tier would be overkill);
  // text content is per-feature so OL declutter sees each name distinctly.
  const peakLabelFill = new Fill({ color: COLOR_INK });
  const peakLabelStroke = new Stroke({ color: COLOR_LAND, width: 2 });

  return function (feature) {
    switch (feature.get("featureClass")) {
      case "bathymetry_deep": return bathymetry_deep;
      case "bathymetry_shallow": return bathymetry_shallow;
      case "glacier": return glacier;
      case "lake": return lake;
      case "land": return land;
      case "marine":
        marine.getText().setText(feature.get("name"));
        return marine;
      case "river":
      case "river_detail":
        return river;
      case "urban_area": return urban_area;
      case "road": return road;
      case "sea_route": return seaRoute;
      case "peak": {
        const elev = feature.get("elevation") || 0;
        const dot = peakDotStyle(elev);
        if (view.getZoom() < PEAK_LABEL_MIN_ZOOM) return dot;
        const name = feature.get("name") || "";
        // Per-feature Text so each peak's label keeps its own string
        // through declutter (same reason as the city labels above).
        const text = new Text({
          font: 'italic 11px "IM Fell English"',
          textAlign: "left",
          offsetX: 9,
          offsetY: 1,
          fill: peakLabelFill,
          stroke: peakLabelStroke,
          text: elev ? `${name} · ${elev} m` : name,
        });
        return [dot, new Style({ zIndex: 851, text })];
      }
    }
  };
}

// PMTiles archive — a single HTTP fetch with byte-range requests for tile
// data. The MVT layer name is exposed to the style function via the
// `layerName: "featureClass"` option, matching the legacy property name.
const pmtilesArchive = new PMTiles(BACKGROUND_URL);

// One factory, two sources: the main background wraps horizontally so the
// world repeats during pan, while marine labels live on a non-wrapping
// source so we can place them in exactly one world copy (the one nearest
// view center, picked by the marine style's geometry override).
function makeBackgroundSource(wrapX) {
  const src = new VectorTileSource({
    format: new MVT({ layerName: "featureClass" }),
    url: "{z}/{x}/{y}",
    wrapX,
    // Must match the tippecanoe `-z` in build-data.mjs — OL will overzoom
    // past this by upscaling z10 tiles, which keeps the texture present
    // even at street-level zooms.
    maxZoom: 10,
  });
  src.setTileLoadFunction((tile, url) => {
    const parts = url.split("/");
    const z = Number(parts[0]);
    const x = Number(parts[1]);
    const y = Number(parts[2]);
    tile.setLoader(async (extent, _resolution, projection) => {
      try {
        const entry = await pmtilesArchive.getZxy(z, x, y);
        if (!entry || !entry.data) {
          tile.setFeatures([]);
          return;
        }
        const features = tile.getFormat().readFeatures(entry.data, {
          extent,
          featureProjection: projection,
        });
        tile.setFeatures(features);
      } catch {
        tile.setFeatures([]);
      }
    });
  });
  return src;
}

const backgroundSource = makeBackgroundSource(true);
const marineSource = makeBackgroundSource(false);

const styleDispatch = backgroundLayerStyle();
const backgroundLayer = new VectorTileLayer({
  declutter: true,
  source: backgroundSource,
  // Marine is drawn by the dedicated layer below — skip it here so we don't
  // get one labelled copy per visible world.
  style: (feature) => feature.get("featureClass") === "marine" ? null : styleDispatch(feature),
});
map.addLayer(backgroundLayer);

const marineLayer = new VectorTileLayer({
  declutter: true,
  source: marineSource,
  style: (feature) => feature.get("featureClass") === "marine" ? styleDispatch(feature) : null,
});
map.addLayer(marineLayer);

/* ── features layer (cities) ──────────────────────────────────────────── */

// City marker: a small filled circle precisely centered on the city's
// coordinates (CircleStyle is centered on its Point geometry). The label
// sits just above the dot, centered horizontally on the same coordinate,
// so the (dot, label) pair visually "points at" the place rather than
// trailing off to the right of a square.
const cityImageFill = new Fill({ color: "rgba(0,0,0,1)" });
const cityImageStroke = new Stroke({ color: "rgba(224,201,166,1)", width: 1 });
const cityShape = new CircleStyle({
  fill: cityImageFill,
  stroke: cityImageStroke,
  radius: 2.5,
});
const cityTextFill = new Fill({ color: "rgba(0,0,0,1)" });
const cityTextStroke = new Stroke({ color: "rgba(224,201,166,1)", width: 2 });
// Dot style is shared and always rendered (`declutterMode: "none"`).
// Label styles are PER-FEATURE — a fresh Text instance is constructed for
// each city in the result handler below. Why not share? OL's declutter pass
// reads each style's Text content at draw time, after the layer's style
// function has run for every visible feature; with a single shared Text the
// `.text` is whatever the last cityName setText() wrote, so all 300 labels
// would render with the same string and declutter would collapse them. The
// fade-in still works on shared Fill/Stroke instances because alpha is the
// same for every newcomer in a given frame.
const cityDotStyle = new Style({ zIndex: 100, image: cityShape, declutterMode: "none" });

// `rank` is the city's index in the worker's score-sorted result for the
// current viewport (0 = the most important city in view). Higher-ranked
// cities get a higher style zIndex so OL's declutter pass resolves them
// first and reserves their label slot before any neighbour can claim it.
// Without this the top hit (e.g. Paris) gets buried inside a dense suburb
// cluster.

function makeCityStyles(name, rank) {
  const text = new Text({
    font: 'bold 14px "IM Fell English"',
    textAlign: "center",
    offsetX: 0,
    offsetY: -10,                      // sits just above the dot
    fill: cityTextFill,
    stroke: cityTextStroke,
    text: name,
  });
  // Higher rank-zero cities get a much higher zIndex so OL's declutter pass
  // resolves them first and reserves their label slot before any neighbour
  // can claim it. With all labels at the same zIndex, OL's tie-break order
  // was hiding the top hit (Paris) inside dense suburb clusters.
  const labelStyle = new Style({
    zIndex: 1000 - rank,
    text,
  });
  return [cityDotStyle, labelStyle];
}

let fadeStartedAt = 0;
let fadeFrame = 0;

// Per-render alpha mutation drives the fade-in. The text content lives on
// each feature's own Style (set in the result handler), so we don't touch it
// here — only the shared Fill/Stroke colors used by every city.
function featuresLayerStyle(feature) {
  let alpha = 1;
  const featureStart = feature.get("_fadeStart");
  if (featureStart !== undefined) {
    const elapsed = performance.now() - featureStart;
    alpha = elapsed >= CITY_FADE_MS ? 1 : Math.max(0, elapsed / CITY_FADE_MS);
  }
  cityImageFill.setColor(`rgba(0,0,0,${alpha})`);
  cityImageStroke.setColor(`rgba(224,201,166,${alpha})`);
  cityTextFill.setColor(`rgba(0,0,0,${alpha})`);
  cityTextStroke.setColor(`rgba(224,201,166,${alpha})`);
  return feature.getStyle();
}

function startFadeTick() {
  if (fadeFrame) return;
  const tick = () => {
    if (performance.now() - fadeStartedAt >= CITY_FADE_MS) {
      fadeFrame = 0;
      map.render(); // one last frame at alpha=1
      return;
    }
    map.render();
    fadeFrame = requestAnimationFrame(tick);
  };
  fadeFrame = requestAnimationFrame(tick);
}

const featuresSource = new VectorSource({ wrapX: true });
const featuresLayer = new VectorLayer({
  renderBuffer: 200,
  declutter: true,
  source: featuresSource,
  style: featuresLayerStyle,
});
map.addLayer(featuresLayer);

/* ── cities worker ────────────────────────────────────────────────────── */

const citiesWorker = new Worker(
  new URL("./cities-worker.js", import.meta.url),
  { type: "module" },
);

let workerReady = false;
let queryCounter = 0;
let latestQueryId = 0;
let searchCounter = 0;
let latestSearchId = 0;

// Diff-keyed by canonical identity so a city that stays visible across a
// zoom step keeps the same Feature instance and doesn't re-fade.
const visibleCities = new Map(); // key → Feature
const cityKey = (c) => `${c.x.toFixed(0)},${c.y.toFixed(0)}|${c.name}`;

citiesWorker.onmessage = (event) => {
  const msg = event.data;
  if (msg.type === "ready") {
    workerReady = true;
    onCitiesReady();
    refreshVisibleCities();
  } else if (msg.type === "result") {
    if (msg.id !== latestQueryId) return;

    const incoming = new Map();
    for (const c of msg.cities) incoming.set(cityKey(c), c);

    // Remove cities that fell out of view.
    for (const [key, feature] of visibleCities) {
      if (!incoming.has(key)) {
        featuresSource.removeFeature(feature);
        visibleCities.delete(key);
      }
    }

    // Add newcomers with a fresh fade. Rank is the city's position in the
    // worker's score-sorted result for this viewport — feeds `makeCityStyles`
    // so the top hits always get a label even in a dense cluster.
    const now = performance.now();
    let added = false;
    let rank = 0;
    for (const [key, city] of incoming) {
      const thisRank = rank++;
      if (visibleCities.has(key)) continue;
      const feature = new Feature({
        geometry: new Point([city.x, city.y]),
        name: city.name,
        featureClass: "city",
      });
      feature.set("_fadeStart", now);
      feature.setStyle(makeCityStyles(city.name, thisRank));
      visibleCities.set(key, feature);
      featuresSource.addFeature(feature);
      added = true;
    }
    if (added) {
      fadeStartedAt = now;
      startFadeTick();
    }
  } else if (msg.type === "search-result") {
    if (msg.id !== latestSearchId) return;
    renderSearchResults(msg.cities);
  }
};

async function bootCitiesWorker() {
  const res = await fetch(CITIES_URL);
  if (!res.ok) throw new Error(`cities.bin → HTTP ${res.status}`);
  const buffer = await trackProgress(res, "cities", 0.5, 1.0);
  citiesWorker.postMessage({ type: "init", buffer }, [buffer]);
}

function refreshVisibleCities() {
  if (!workerReady) return;
  const [minX, minY, maxX, maxY] = view.calculateExtent(map.getSize());
  const id = ++queryCounter;
  latestQueryId = id;
  citiesWorker.postMessage({
    type: "query",
    id,
    minX, minY, maxX, maxY,
    limit: MAX_VISIBLE_CITIES,
  });
}

map.on("moveend", refreshVisibleCities);

/* ── loading overlay & progress ───────────────────────────────────────── */

const loadingEl = document.getElementById("loading");
const loadingBarEl = document.getElementById("loading-bar-fill");
const loadingStatusEl = document.getElementById("loading-status");

const progress = { background: 0, cities: 0 };
function setProgress(kind, frac) {
  progress[kind] = Math.max(progress[kind], frac);
  const overall = 0.5 * progress.background + 0.5 * progress.cities;
  loadingBarEl.style.width = `${Math.min(100, overall * 100)}%`;
}

// Streams a Response while reporting fractional progress into the shared
// loading bar. Falls back to "indeterminate" half-progress if Content-Length
// isn't exposed.
async function trackProgress(response, kind) {
  const total = Number(response.headers.get("Content-Length")) || 0;
  if (!total || !response.body) {
    setProgress(kind, 1);
    return response.arrayBuffer();
  }
  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    setProgress(kind, received / total);
  }
  const out = new Uint8Array(received);
  let pos = 0;
  for (const c of chunks) {
    out.set(c, pos);
    pos += c.length;
  }
  setProgress(kind, 1);
  return out.buffer;
}

// Background: PMTiles streams in tile by tile, so "loaded" means "the first
// frame's worth of tiles has rendered". `rendercomplete` fires once OL has
// nothing left to fetch or render for the current view.
let bgFirstTileStarted = false;
backgroundSource.on("tileloadstart", () => {
  if (bgFirstTileStarted) return;
  bgFirstTileStarted = true;
  loadingStatusEl.textContent = "terras explicantur";
  setProgress("background", 0.5);
});
backgroundSource.on("tileloaderror", () => {
  loadingStatusEl.textContent = "charta rumpitur — try refreshing";
});
map.once("rendercomplete", () => {
  setProgress("background", 1);
  backgroundLoaded = true;
  maybeHideLoading();
});

let citiesLoaded = false;
let backgroundLoaded = false;

function onCitiesReady() {
  citiesLoaded = true;
  maybeHideLoading();
}

function maybeHideLoading() {
  if (!citiesLoaded || !backgroundLoaded) return;
  // Wait one frame so the first paint settles before we fade out the overlay.
  requestAnimationFrame(() => {
    loadingStatusEl.textContent = "tabula aperta";
    loadingEl.classList.add("hidden");
    setTimeout(() => loadingEl.remove(), 800);
  });
}

// Watchdog: if the user is offline / data missing, surface the status text.
const watchdog = setTimeout(() => {
  if (!loadingEl.classList.contains("hidden")) {
    loadingStatusEl.textContent = "patientia … magna est charta";
  }
}, 4000);
window.addEventListener("beforeunload", () => clearTimeout(watchdog));

bootCitiesWorker().catch((err) => {
  console.error(err);
  loadingStatusEl.textContent = "could not load cities — see console";
});

/* ── search palette (cmd/ctrl + K|F) ──────────────────────────────────── */

const searchEl = document.getElementById("search");
const searchBackdropEl = document.getElementById("search-backdrop");
const searchInput = document.getElementById("search-input");
const searchResultsEl = document.getElementById("search-results");

let searchOpen = false;
let searchHighlight = 0;
let searchHits = [];

function openSearch() {
  searchOpen = true;
  searchEl.classList.add("visible");
  searchBackdropEl.classList.add("visible");
  searchInput.value = "";
  searchResultsEl.innerHTML = "";
  searchInput.focus();
}

function closeSearch() {
  searchOpen = false;
  searchEl.classList.remove("visible");
  searchBackdropEl.classList.remove("visible");
}

function querySearch(q) {
  if (!workerReady) return;
  const id = ++searchCounter;
  latestSearchId = id;
  citiesWorker.postMessage({ type: "search", id, q, limit: 12 });
}

// `c.display` is pre-baked at build time: "🇫🇷 Paris, France" (flag + city +
// localised country name). No runtime dedup, no Intl, no concatenation —
// arrondissement-style entries were folded into their parents in build-data
// and PPLX entries were dropped from cities.bin entirely.
function renderSearchResults(cities) {
  searchHighlight = 0;
  searchHits = cities;
  if (cities.length === 0) {
    searchResultsEl.innerHTML = `<div class="search-empty">no city found</div>`;
    return;
  }
  searchResultsEl.innerHTML = cities
    .map((c, idx) =>
      `<div class="search-result ${idx === 0 ? "active" : ""}" data-idx="${idx}">
        <span class="name">${escapeHtml(c.display)}</span>
      </div>`,
    )
    .join("");
}

function escapeHtml(s) {
  return s.replace(/[&<>"]/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
  }[c]));
}

function highlightSearch(idx) {
  const items = searchResultsEl.querySelectorAll(".search-result");
  if (items.length === 0) return;
  searchHighlight = ((idx % items.length) + items.length) % items.length;
  items.forEach((el, i) => el.classList.toggle("active", i === searchHighlight));
  items[searchHighlight].scrollIntoView({ block: "nearest" });
}

function zoomForCity(pop) {
  if (pop > 10_000_000) return 8;
  if (pop > 1_000_000) return 9;
  if (pop > 100_000) return 10;
  if (pop > 10_000) return 11;
  return 12;
}

function jumpTo(city) {
  closeSearch();
  view.animate({
    center: [city.x, city.y],
    zoom: zoomForCity(city.population),
    duration: 900,
  });
}

searchInput.addEventListener("input", () => {
  const q = searchInput.value;
  if (!q.trim()) {
    searchResultsEl.innerHTML = "";
    searchHits = [];
    return;
  }
  querySearch(q);
});

searchInput.addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown") {
    e.preventDefault();
    highlightSearch(searchHighlight + 1);
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    highlightSearch(searchHighlight - 1);
  } else if (e.key === "Enter") {
    e.preventDefault();
    if (searchHits[searchHighlight]) jumpTo(searchHits[searchHighlight]);
  } else if (e.key === "Escape") {
    e.preventDefault();
    closeSearch();
  }
});

searchResultsEl.addEventListener("click", (e) => {
  const el = e.target.closest(".search-result");
  if (!el) return;
  const idx = Number(el.dataset.idx);
  if (searchHits[idx]) jumpTo(searchHits[idx]);
});

searchBackdropEl.addEventListener("click", closeSearch);

window.addEventListener("keydown", (e) => {
  const cmd = e.metaKey || e.ctrlKey;
  if (cmd && (e.key === "k" || e.key === "K" || e.key === "f" || e.key === "F")) {
    e.preventDefault();
    if (searchOpen) closeSearch();
    else openSearch();
  } else if (e.key === "Escape" && searchOpen) {
    closeSearch();
  }
});

/* ── paper sound on drag ──────────────────────────────────────────────── */

let audioCtx;
let lastRustleAt = 0;
function paperRustle() {
  const now = performance.now();
  if (now - lastRustleAt < 450) return;
  lastRustleAt = now;
  try {
    audioCtx ??= new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") audioCtx.resume();
    const dur = 0.18;
    const bufSize = Math.floor(audioCtx.sampleRate * dur);
    const buf = audioCtx.createBuffer(1, bufSize, audioCtx.sampleRate);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < bufSize; i++) {
      const env = (1 - i / bufSize) ** 1.8;
      ch[i] = (Math.random() * 2 - 1) * env;
    }
    const src = audioCtx.createBufferSource();
    src.buffer = buf;
    const filter = audioCtx.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.value = 2200;
    filter.Q.value = 0.6;
    const gain = audioCtx.createGain();
    gain.gain.value = 0.04;
    src.connect(filter).connect(gain).connect(audioCtx.destination);
    src.start();
  } catch {
    // Audio is purely decorative; ignore failures (autoplay policy, no audio, etc.).
  }
}

/* ── interactions ─────────────────────────────────────────────────────── */

map.on("dblclick", (e) => e.preventDefault());

map.on("pointerdrag", () => {
  document.body.classList.add("cursor-move");
  paperRustle();
});

document.addEventListener("mouseup", () => {
  document.body.classList.remove("cursor-move");
});

/* ── context menu ─────────────────────────────────────────────────────── */

const contextMenuElement = document.getElementById("context-menu");
const coordinatesElement = contextMenuElement.querySelector(
  '[data-action="coordinates"]'
);

map.on("contextmenu", (event) => {
  event.preventDefault();
  const feature = getFeatureAtPixel(event);
  const [lon, lat] = feature
    ? toLonLat(feature.getGeometry().getCoordinates())
    : toLonLat(event.coordinate);
  coordinatesElement.innerHTML = `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
  coordinatesElement.setAttribute("data-lat", lat);
  coordinatesElement.setAttribute("data-lon", lon);

  let x = event.originalEvent.clientX;
  const xDelta = x + contextMenuElement.offsetWidth - document.body.offsetWidth;
  if (xDelta > 0) x -= xDelta;
  let y = event.originalEvent.clientY;
  const yDelta = y + contextMenuElement.offsetHeight - document.body.offsetHeight;
  if (yDelta > 0) y -= yDelta;

  contextMenuElement.style.top = `${y}px`;
  contextMenuElement.style.left = `${x}px`;
  contextMenuElement.classList.add("visible");
});

document.body.addEventListener("mousedown", (event) => {
  if (event.target.offsetParent === contextMenuElement) {
    event.preventDefault();
    const lat = coordinatesElement.getAttribute("data-lat");
    const lon = coordinatesElement.getAttribute("data-lon");
    switch (event.target.getAttribute("data-action")) {
      case "coordinates":
        navigator.clipboard.writeText([lat, lon].join(", "));
        break;
      case "fullscreen":
        mapElement.requestFullscreen();
        break;
      case "googlemaps": {
        const latlon = encodeURIComponent([lat, lon].join(","));
        window.open(
          `https://www.google.com/maps?q=${latlon}&ll=${latlon}&z=8`,
          "_blank",
        );
        break;
      }
    }
  }
  contextMenuElement.classList.remove("visible");
});

function getFeatureAtPixel(event) {
  return map.forEachFeatureAtPixel(
    event.pixel,
    (feature) => (feature.get("featureClass") === "city" ? feature : undefined),
    { hitTolerance: 4, layerFilter: (layer) => layer === featuresLayer },
  );
}
