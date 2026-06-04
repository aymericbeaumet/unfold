// Owns the cities.bin ArrayBuffer (transferred zero-copy from the main thread)
// and answers two query types:
//   - bbox: top-N highest-scored cities inside a Mercator rectangle
//   - search: top-N cities matching a normalized text query
//
// Coordinates ship pre-projected to EPSG:3857 (Web Mercator metres); the
// view extent the main thread sends is already in those units too. Each
// city ships TWO strings, both baked at build time:
//   - `name`    : just the city ("Paris"), used by the on-map label
//   - `display` : the formatted search palette row ("🇫🇷 Paris, France")
//
// Wire protocol:
//   ← { type: "init", buffer: ArrayBuffer }        (buffer is transferred)
//   → { type: "ready" }
//   ← { type: "query", id, minX, minY, maxX, maxY, limit? }
//   → { type: "result", id, cities: [{ name, x, y, population }, ...] }
//   ← { type: "search", id, q, limit? }
//   → { type: "search-result", id, cities: [{ display, x, y, population }, ...] }

const HEADER_FIELDS = 11;
const DEFAULT_BBOX_LIMIT = 100;
const DEFAULT_SEARCH_LIMIT = 12;
const decoder = new TextDecoder();

// 2 × π × earthRadius — the full horizontal span of the Web Mercator world.
const MERCATOR_WORLD = 2 * Math.PI * 6378137;

let count = 0;
let xs, ys, pops;
let nameOffsets, names, displayOffsets, displays, searchOffsets, searches;

function init(buffer) {
  const h = new Uint32Array(buffer, 0, HEADER_FIELDS);
  count = h[0];
  xs = new Float32Array(buffer, h[1], count);
  ys = new Float32Array(buffer, h[2], count);
  pops = new Uint32Array(buffer, h[3], count);
  nameOffsets = new Uint32Array(buffer, h[4], count + 1);
  names = new Uint8Array(buffer, h[5]);
  displayOffsets = new Uint32Array(buffer, h[6], count + 1);
  displays = new Uint8Array(buffer, h[7]);
  searchOffsets = new Uint32Array(buffer, h[8], count + 1);
  searches = new Uint8Array(buffer, h[9]);
}

function nameAt(i) {
  return decoder.decode(names.subarray(nameOffsets[i], nameOffsets[i + 1]));
}

function displayAt(i) {
  return decoder.decode(displays.subarray(displayOffsets[i], displayOffsets[i + 1]));
}

// bbox results need the plain `name` for the on-map label; search results
// need the formatted `display` for the palette row. Separate row builders
// keep each payload minimal.
function bboxRow(i) {
  return {
    name: nameAt(i),
    x: xs[i],
    y: ys[i],
    population: pops[i],
  };
}
function searchRow(i) {
  return {
    display: displayAt(i),
    x: xs[i],
    y: ys[i],
    population: pops[i],
  };
}

// Handles antimeridian wrap: if the requested span exceeds the full Mercator
// world width (the user is zoomed out and the map repeats horizontally),
// every city is visible somewhere. Otherwise a city at canonical X is
// in-bbox iff (X − minX) mod WORLD ≤ span.
function bboxQuery(minX, minY, maxX, maxY, limit) {
  const span = Math.min(MERCATOR_WORLD, maxX - minX);
  const out = [];
  for (let i = 0; i < count && out.length < limit; i++) {
    const y = ys[i];
    if (y < minY || y > maxY) continue;
    const x = xs[i];
    let delta = (x - minX) % MERCATOR_WORLD;
    if (delta < 0) delta += MERCATOR_WORLD;
    if (delta <= span) out.push(bboxRow(i));
  }
  return out;
}

// Encode the query once into UTF-8 tokens and scan the precomputed search
// strings as raw bytes. Avoids allocating 230k JS strings per keystroke.
function searchQuery(query, limit) {
  const normalized = query
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
  if (!normalized) return [];

  const encoder = new TextEncoder();
  const tokens = normalized
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((t) => encoder.encode(t));
  if (tokens.length === 0) return [];

  // A match must contain every token. The first token must additionally start
  // a name (i.e. appear at offset 0 or right after a space) so "par" prefers
  // "Paris" over "Asparagus".
  const out = [];
  for (let i = 0; i < count && out.length < limit; i++) {
    const start = searchOffsets[i];
    const end = searchOffsets[i + 1];
    if (!hasTokenAtNameStart(start, end, tokens[0])) continue;
    let allMatch = true;
    for (let t = 1; t < tokens.length; t++) {
      if (indexOfBytes(start, end, tokens[t]) < 0) {
        allMatch = false;
        break;
      }
    }
    if (allMatch) out.push(searchRow(i));
  }
  return out;
}

function hasTokenAtNameStart(start, end, token) {
  // Name occupies the bytes before the first space in the search string.
  // Match if token === name or name starts with token.
  const tlen = token.length;
  if (tlen === 0 || start + tlen > end) return false;
  for (let k = 0; k < tlen; k++) {
    if (searches[start + k] !== token[k]) return false;
  }
  return true;
}

function indexOfBytes(start, end, token) {
  const tlen = token.length;
  if (tlen === 0) return start;
  const last = end - tlen;
  outer: for (let i = start; i <= last; i++) {
    for (let k = 0; k < tlen; k++) {
      if (searches[i + k] !== token[k]) continue outer;
    }
    return i;
  }
  return -1;
}

self.onmessage = (event) => {
  const msg = event.data;
  switch (msg.type) {
    case "init":
      init(msg.buffer);
      self.postMessage({ type: "ready" });
      break;
    case "query": {
      const cities = bboxQuery(
        msg.minX, msg.minY, msg.maxX, msg.maxY,
        msg.limit || DEFAULT_BBOX_LIMIT,
      );
      self.postMessage({ type: "result", id: msg.id, cities });
      break;
    }
    case "search": {
      const cities = searchQuery(msg.q, msg.limit || DEFAULT_SEARCH_LIMIT);
      self.postMessage({ type: "search-result", id: msg.id, cities });
      break;
    }
  }
};
