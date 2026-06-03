import VectorLayer from "ol/layer/Vector";
import VectorImageLayer from "ol/layer/VectorImage";
import GraticuleLayer from "ol/layer/Graticule";
import VectorSource from "ol/source/Vector";
import Feature from "ol/Feature";
import Point from "ol/geom/Point";
import { Fill, Style, RegularShape, Text, Stroke } from "ol/style";
import { GeoJSON } from "ol/format";
import { View, Map } from "ol";
import { fromLonLat, toLonLat } from "ol/proj";

import BACKGROUND_URL from "url:./data/background.geojson";
import CITIES_URL from "url:./data/cities.bin";

/* ── theme ─────────────────────────────────────────────────────────────── */

const COLOR_GRATICULE = "#5E5E5E";
const COLOR_INK = "#000000";
const COLOR_LAND = "#E0C9A6";
const COLOR_WATER = "#F0DEC2";
const COLOR_WATER_SHALLOW = "#D6C6AB";
const COLOR_WATER_DEEP = "#BDAE97";

const MAX_VISIBLE_CITIES = 100;
const CITY_FADE_MS = 350;

// Web Mercator vertical extent (meters).
const MERCATOR_Y_MAX = 20037508.342789244;

/* ── map ──────────────────────────────────────────────────────────────── */

const mapElement = document.getElementById("map");
const view = new View({
  center: fromLonLat([2.3522, 48.8566]),
  zoom: 6,
  // Lock the view inside the latitudinal extent of the map; horizontal pan
  // can run freely so the wrapX sources below can repeat the world.
  extent: [-Infinity, -MERCATOR_Y_MAX, Infinity, MERCATOR_Y_MAX],
  constrainOnlyCenter: false,
});

const map = new Map({
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

/* ── background layer ─────────────────────────────────────────────────── */

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
  const marine = new Style({
    zIndex: 400,
    text: new Text({
      fill: new Fill({ color: COLOR_INK }),
      font: 'bold 18px "Luminari"',
    }),
  });
  const glacier = new Style({ zIndex: 500, fill: new Fill({ color: "darkgray" }) });
  const river = new Style({ zIndex: 600, stroke: new Stroke({ color: COLOR_INK, width: 1 }) });
  const lake = new Style({
    zIndex: 700,
    fill: new Fill({ color: COLOR_WATER }),
    stroke: new Stroke({ color: COLOR_INK, width: 1 }),
  });

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
      case "river": return river;
    }
  };
}

const backgroundSource = new VectorSource({
  format: new GeoJSON(),
  url: BACKGROUND_URL,
  wrapX: true,
});

// imageRatio: 3 keeps the rasterised cache pre-scaled, so the layer doesn't
// have to re-vectorize on every zoom step — pan/zoom feels much smoother
// at the cost of some VRAM. declutter keeps marine labels from overlapping.
const backgroundLayer = new VectorImageLayer({
  declutter: true,
  imageRatio: 3,
  style: backgroundLayerStyle(),
  source: backgroundSource,
});
map.addLayer(backgroundLayer);

/* ── features layer (cities) ──────────────────────────────────────────── */

// The style is a single mutable Style instance — we set the text and rgba
// alphas per-feature on each render pass so newly-added features can fade in.
const cityImageFill = new Fill({ color: "rgba(0,0,0,1)" });
const cityImageStroke = new Stroke({ color: "rgba(224,201,166,1)", width: 1 });
const cityShape = new RegularShape({
  fill: cityImageFill,
  stroke: cityImageStroke,
  points: 4,
  radius: 6,
  angle: Math.PI / 4,
});
const cityTextFill = new Fill({ color: "rgba(0,0,0,1)" });
const cityTextStroke = new Stroke({ color: "rgba(224,201,166,1)", width: 2 });
const cityText = new Text({
  font: 'bold 14px "Luminari"',
  textAlign: "left",
  offsetX: 8,
  offsetY: 2,
  fill: cityTextFill,
  stroke: cityTextStroke,
});
const cityStyle = new Style({ zIndex: 100, image: cityShape, text: cityText });

let fadeStartedAt = 0;
let fadeFrame = 0;

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
  cityText.setText(feature.get("name"));
  return cityStyle;
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
const cityKey = (c) => `${c.lon.toFixed(4)},${c.lat.toFixed(4)}|${c.name}`;

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

    // Add newcomers with a fresh fade.
    const now = performance.now();
    let added = false;
    for (const [key, city] of incoming) {
      if (visibleCities.has(key)) continue;
      const feature = new Feature({
        geometry: new Point(fromLonLat([city.lon, city.lat])),
        name: city.name,
        featureClass: "city",
      });
      feature.set("_fadeStart", now);
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
  const extent = view.calculateExtent(map.getSize());
  const [minLon, minLat] = toLonLat(extent.slice(0, 2));
  const [maxLon, maxLat] = toLonLat(extent.slice(2, 4));
  const id = ++queryCounter;
  latestQueryId = id;
  citiesWorker.postMessage({
    type: "query",
    id,
    minLon, minLat, maxLon, maxLat,
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

// Background: feed real bytes-loaded into the bar via OL's "featuresloadend"
// event instead of fetch streaming, because OL owns that fetch.
backgroundSource.on("featuresloadstart", () => {
  loadingStatusEl.textContent = "terras explicantur";
});
backgroundSource.on("featuresloadend", () => {
  setProgress("background", 1);
  backgroundLoaded = true;
  maybeHideLoading();
});
backgroundSource.on("featuresloaderror", () => {
  loadingStatusEl.textContent = "charta rumpitur — try refreshing";
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

function renderSearchResults(cities) {
  searchHits = cities;
  searchHighlight = 0;
  if (cities.length === 0) {
    searchResultsEl.innerHTML = `<div class="search-empty">no city found</div>`;
    return;
  }
  const regionNames = new Intl.DisplayNames(["en"], { type: "region" });
  searchResultsEl.innerHTML = cities
    .map((c, idx) => {
      let country = c.country.trim();
      try { country = regionNames.of(country) || country; } catch {}
      const pop = c.population
        ? c.population.toLocaleString("en")
        : "—";
      return `<div class="search-result ${idx === 0 ? "active" : ""}" data-idx="${idx}">
        <span class="name">${escapeHtml(c.name)}</span>
        <span class="meta">${escapeHtml(country)} · ${pop}</span>
      </div>`;
    })
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
    center: fromLonLat([city.lon, city.lat]),
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

/* ── graticule ────────────────────────────────────────────────────────── */

const graticuleLayer = new GraticuleLayer({
  strokeStyle: new Stroke({ color: COLOR_GRATICULE }),
  maxZoom: 5,
  intervals: [10],
  showLabels: true,
  lonLabelFormatter: (lon) => String(lon < 0 ? lon + 360 : lon),
  latLabelFormatter: (lat) => String(Math.abs(lat)),
});
map.addLayer(graticuleLayer);

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
    { hitTolerance: 4 },
  );
}
