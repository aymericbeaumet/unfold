// Owns the cities.bin ArrayBuffer (transferred zero-copy from the main thread)
// and answers two query types:
//   - bbox: top-N highest-scored cities inside a lon/lat rectangle
//   - search: top-N cities matching a normalized text query
//
// Wire protocol:
//   ← { type: "init", buffer: ArrayBuffer }        (buffer is transferred)
//   → { type: "ready" }
//   ← { type: "query", id, minLon, minLat, maxLon, maxLat, limit? }
//   → { type: "result", id, cities: [{ name, country, lon, lat, population }, ...] }
//   ← { type: "search", id, q, limit? }
//   → { type: "search-result", id, cities: [...] }

const HEADER_FIELDS = 10;
const DEFAULT_BBOX_LIMIT = 100;
const DEFAULT_SEARCH_LIMIT = 12;
const decoder = new TextDecoder();

let count = 0;
let lons, lats, pops, countries;
let nameOffsets, names, searchOffsets, searches;

function init(buffer) {
  const h = new Uint32Array(buffer, 0, HEADER_FIELDS);
  count = h[0];
  lons = new Float32Array(buffer, h[1], count);
  lats = new Float32Array(buffer, h[2], count);
  pops = new Uint32Array(buffer, h[3], count);
  countries = new Uint8Array(buffer, h[4], count * 2);
  nameOffsets = new Uint32Array(buffer, h[5], count + 1);
  names = new Uint8Array(buffer, h[6]);
  searchOffsets = new Uint32Array(buffer, h[7], count + 1);
  searches = new Uint8Array(buffer, h[8]);
}

function nameAt(i) {
  return decoder.decode(names.subarray(nameOffsets[i], nameOffsets[i + 1]));
}

function countryAt(i) {
  return String.fromCharCode(countries[i * 2]) + String.fromCharCode(countries[i * 2 + 1]);
}

function row(i) {
  return {
    name: nameAt(i),
    country: countryAt(i),
    lon: lons[i],
    lat: lats[i],
    population: pops[i],
  };
}

// Handles antimeridian wrap: if the requested span exceeds 360° (the user has
// zoomed all the way out and the map repeats horizontally), every city is
// visible somewhere. Otherwise a city at canonical lon L is in-bbox iff
// (L − minLon) mod 360 ≤ span.
function bboxQuery(minLon, minLat, maxLon, maxLat, limit) {
  const span = Math.min(360, maxLon - minLon);
  const out = [];
  for (let i = 0; i < count && out.length < limit; i++) {
    const lat = lats[i];
    if (lat < minLat || lat > maxLat) continue;
    const lon = lons[i];
    let delta = (lon - minLon) % 360;
    if (delta < 0) delta += 360;
    if (delta <= span) out.push(row(i));
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
    if (allMatch) out.push(row(i));
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
        msg.minLon, msg.minLat, msg.maxLon, msg.maxLat,
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
