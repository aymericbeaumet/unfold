// Generic point-dataset worker. Loads ONE .bin file in the shared layout
// (see build-data.mjs#buildPointsBin) and answers zoom-filtered queries
// against it.
//
// Items are stored in DESCENDING score order. The worker returns the
// top-N items globally whose per-feature minZoom is ≤ the current view
// zoom. There's no bbox filter: panning east/west/north/south doesn't
// change which items are returned, which gives the renderer a stable set
// of features per zoom level. The main thread handles per-pan world-copy
// duplication so points still render correctly when the world wraps.
//
// Header layout (10 × u32 = 40 bytes, all byte offsets into the buffer):
//   count, xsOff, ysOff,
//   scoresOff, zoomsOff,
//   labelOffsetsOff, labelsOff,
//   metaOffsetsOff,  metasOff,
//   totalSize
//
// Wire protocol:
//   ← { type: "init", buffer }                  (transferred)
//   → { type: "ready" }
//   ← { type: "query", id, zoom, limit? }
//   → { type: "result", id, items: [{ x, y, score, label, meta }, ...] }

const HEADER_FIELDS = 10;
const DEFAULT_LIMIT = 200;
const decoder = new TextDecoder();

let count = 0;
let xs, ys, scores, zooms;
let labelOffs, labels, metaOffs, metas;

function init(buffer) {
  const h = new Uint32Array(buffer, 0, HEADER_FIELDS);
  count = h[0];
  xs = new Float32Array(buffer, h[1], count);
  ys = new Float32Array(buffer, h[2], count);
  scores = new Uint32Array(buffer, h[3], count);
  zooms = new Uint8Array(buffer, h[4], count);
  labelOffs = new Uint32Array(buffer, h[5], count + 1);
  labels = new Uint8Array(buffer, h[6]);
  metaOffs = new Uint32Array(buffer, h[7], count + 1);
  metas = new Uint8Array(buffer, h[8]);
}

function labelAt(i) {
  return decoder.decode(labels.subarray(labelOffs[i], labelOffs[i + 1]));
}
function metaAt(i) {
  const start = metaOffs[i];
  const end = metaOffs[i + 1];
  if (end === start) return null;
  try {
    return JSON.parse(decoder.decode(metas.subarray(start, end)));
  } catch {
    return null;
  }
}

// Global top-N by score, filtered by per-feature minZoom. Score-sorted
// scan terminates at limit. Monotone in zoom: zoom-in only ever adds
// features (their minZoom drops below the new zoom floor), never removes.
function topQuery(zoom, limit) {
  const out = [];
  const zoomFloor = Math.floor(zoom);
  for (let i = 0; i < count && out.length < limit; i++) {
    if (zooms[i] > zoomFloor) continue;
    out.push({
      x: xs[i],
      y: ys[i],
      score: scores[i],
      label: labelAt(i),
      meta: metaAt(i),
    });
  }
  return out;
}

self.onmessage = (event) => {
  const msg = event.data;
  switch (msg.type) {
    case "init":
      init(msg.buffer);
      self.postMessage({ type: "ready" });
      break;
    case "query": {
      const items = topQuery(msg.zoom ?? 0, msg.limit || DEFAULT_LIMIT);
      self.postMessage({ type: "result", id: msg.id, items });
      break;
    }
  }
};
