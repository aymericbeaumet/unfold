// Owns the cities.bin ArrayBuffer (transferred zero-copy from the main thread)
// and answers two query types:
//   - top: super-capitals (capital AND pop >= 1M) + top-N by population
//   - search: top-N cities matching a normalized text query
//
// "Biggest city wins overlap" is the product rule: declutter must keep the
// largest city when labels collide. To support that, the worker emits its
// global top-N sorted by POPULATION (not the score with the +1B capital
// boost). Super-capitals (capital AND pop >= 1M) are ALWAYS included
// regardless of the limit, marked with `super: 1` — the main thread routes
// those to a dedicated no-declutter layer so they render unconditionally.
//
// The bin is sorted by SCORE at build time (capitals at the head). We
// build a popSortedIndices array at init that re-indexes by population so
// the "top-N by pop" loop runs in O(limit) without rescanning the whole
// bin per query. capitalCount tells the worker which indices belong to
// the capital block (the first capitalCount entries in score order).
//
// Coordinates ship pre-projected to EPSG:3857 (Web Mercator metres). Each
// city ships TWO strings, both baked at build time:
//   - `name`    : just the city ("Paris"), used by the on-map label
//   - `display` : the formatted search palette row ("🇫🇷 Paris, France")
//
// Wire protocol:
//   ← { type: "init", buffer: ArrayBuffer }        (buffer is transferred)
//   → { type: "ready" }
//   ← { type: "query", id, limit? }                (no bbox: global top)
//   → { type: "result", id, cities: [{ name, x, y, population, wiki, capital }, ...] }
//   ← { type: "search", id, q, limit? }
//   → { type: "search-result", id, cities: [{ display, x, y, population }, ...] }

const HEADER_FIELDS = 14;
const DEFAULT_TOP_LIMIT = 200;
const DEFAULT_SEARCH_LIMIT = 12;
const SUPER_CAPITAL_POP_MIN = 1_000_000;
const decoder = new TextDecoder();

let count = 0;
let capitalCount = 0;
let xs, ys, pops;
let nameOffsets, names, displayOffsets, displays;
let searchOffsets, searches, wikiOffsets, wikis;
// Indices into the bin re-sorted by population descending. Built once at
// init so every topQuery is O(limit). Filled at the end of init().
let popSortedIndices = null;
// Reverse map binIndex → popRank, so topRow can attach the rank to each
// city object without scanning popSortedIndices per call.
let popRankByBinIndex = null;

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
  wikiOffsets = new Uint32Array(buffer, h[10], count + 1);
  wikis = new Uint8Array(buffer, h[11]);
  // Defensive: if the bin pre-dates the capitalCount field, h[13] is
  // garbage from the xs section. Clamp to [0, count] so topQuery still
  // returns sane output instead of looping over nonsense.
  const raw = h[13];
  capitalCount = (Number.isFinite(raw) && raw >= 0 && raw <= count) ? raw : 0;

  // Sort indices by population (descending) so topQuery can slice the
  // global top-N by pop in one linear pass. ~50 ms for 200 k cities,
  // paid once at worker startup.
  const indices = new Array(count);
  for (let i = 0; i < count; i++) indices[i] = i;
  indices.sort((a, b) => pops[b] - pops[a]);
  popSortedIndices = new Uint32Array(indices);

  // Build a reverse map (binIndex → popRank) so topRow can tell each
  // city its rank in pop-sorted order without a per-call O(n) scan. Used
  // by the main thread to route features to the correct tier-band source.
  popRankByBinIndex = new Uint32Array(count);
  for (let k = 0; k < count; k++) {
    popRankByBinIndex[popSortedIndices[k]] = k;
  }

  // Allocate decode caches and FILL them eagerly. Decoding 196 k names
  // + 196 k wikis upfront is ~1 s, all on worker startup. After this,
  // every topQuery is O(limit) with no decoder.decode() calls on the
  // hot path — the main thread can fly between tier changes without
  // the worker stalling on per-string UTF-8 conversion.
  nameCache = new Array(count);
  wikiCache = new Array(count);
  displayCache = new Array(count);
  for (let i = 0; i < count; i++) {
    nameCache[i] = decoder.decode(names.subarray(nameOffsets[i], nameOffsets[i + 1]));
    wikiCache[i] = decoder.decode(wikis.subarray(wikiOffsets[i], wikiOffsets[i + 1]));
  }
}

// Lazy decode caches. The first topQuery for a high-zoom tier touches
// tens of thousands of names + wikis; without caching, each subsequent
// query (re-render after pan/zoom) would pay the same ~250 ms decode
// cost. The arrays grow as needed and shared across queries.
let nameCache;
let wikiCache;
let displayCache;
function nameAt(i) {
  return nameCache[i] !== undefined
    ? nameCache[i]
    : (nameCache[i] = decoder.decode(names.subarray(nameOffsets[i], nameOffsets[i + 1])));
}
function displayAt(i) {
  return displayCache[i] !== undefined
    ? displayCache[i]
    : (displayCache[i] = decoder.decode(displays.subarray(displayOffsets[i], displayOffsets[i + 1])));
}
function wikiAt(i) {
  return wikiCache[i] !== undefined
    ? wikiCache[i]
    : (wikiCache[i] = decoder.decode(wikis.subarray(wikiOffsets[i], wikiOffsets[i + 1])));
}

// Top-N results carry the plain `name` (for the on-map label) plus the
// pre-built `wiki` string ("City, State, Country") so the click handler
// can open a Wikipedia search with proper disambiguation without doing
// any extra lookup work on the main thread. `capital`=1 if PPLC, `super`=1
// if a super-capital (capital AND pop >= 1M) — the renderer routes super-
// capitals to the no-declutter layer so they always render.
function topRow(i, capital, isSuper) {
  return {
    name: nameAt(i),
    x: xs[i],
    y: ys[i],
    population: pops[i],
    wiki: wikiAt(i),
    capital,
    super: isSuper,
    popRank: popRankByBinIndex[i],
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

// Global top query: ALL super-capitals (capital AND pop >= 1M) +
// top-N globally by population. Super-capitals are included even if
// their pop pushes them below the top-N — they're the always-render set.
// The remaining slots go to the top-N by population, so the BIGGEST
// cities (regardless of capital status) win their overlap contests.
function topQuery(limit) {
  const out = [];
  const seen = new Set();
  // First: super-capitals. Iterate the capital block (indices 0..capitalCount)
  // and include any with pop >= 1M. ~50 entries at most.
  for (let i = 0; i < capitalCount; i++) {
    if (pops[i] >= SUPER_CAPITAL_POP_MIN) {
      seen.add(i);
      out.push(topRow(i, 1, 1));
    }
  }
  // Second: top-N by population (skip already-included super capitals).
  let added = 0;
  for (let k = 0; k < count && added < limit; k++) {
    const i = popSortedIndices[k];
    if (seen.has(i)) continue;
    const isCapital = i < capitalCount ? 1 : 0;
    out.push(topRow(i, isCapital, 0));
    added++;
  }
  return out;
}

// Encode the query once into UTF-8 tokens and scan the precomputed search
// strings as raw bytes. Avoids allocating 230k JS strings per keystroke.
//
// Tokens are stripped of non-letter characters (dashes, apostrophes,
// dots, etc.) so a user typing "newyork" matches "new york", "saintpaul"
// matches "saint-paul", "coteivoire" matches "côte d'ivoire". The bin's
// search strings carry a leading stripped name to make this work — see
// `searchString` in build-data.mjs.
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
    .map((t) => t.replace(/[^a-z0-9]/g, ""))
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
      const cities = topQuery(msg.limit || DEFAULT_TOP_LIMIT);
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
