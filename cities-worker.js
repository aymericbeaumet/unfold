// Owns the cities.bin ArrayBuffer (transferred zero-copy from the main thread)
// and answers bbox queries via a score-ordered linear scan with early
// termination — worst case ~2 ms even on a viewport with no matches.
//
// Wire protocol:
//   ← { type: "init", buffer: ArrayBuffer }   (buffer is transferred)
//   → { type: "ready" }
//   ← { type: "query", id, minLon, minLat, maxLon, maxLat, limit? }
//   → { type: "result", id, cities: [[name, lon, lat], ...] }

const HEADER_SIZE = 4;
const DEFAULT_LIMIT = 100;
const decoder = new TextDecoder();

let count = 0;
let lons; // Float32Array
let lats; // Float32Array
let offsets; // Uint32Array, length count+1
let names; // Uint8Array (raw utf-8 buffer)

function init(buffer) {
  count = new Uint32Array(buffer, 0, 1)[0];
  const lonsSize = count * 4;
  const latsSize = count * 4;
  const offsetsSize = (count + 1) * 4;

  lons = new Float32Array(buffer, HEADER_SIZE, count);
  lats = new Float32Array(buffer, HEADER_SIZE + lonsSize, count);
  offsets = new Uint32Array(buffer, HEADER_SIZE + lonsSize + latsSize, count + 1);
  names = new Uint8Array(buffer, HEADER_SIZE + lonsSize + latsSize + offsetsSize);
}

function nameAt(i) {
  return decoder.decode(names.subarray(offsets[i], offsets[i + 1]));
}

function query(minLon, minLat, maxLon, maxLat, limit) {
  const out = [];
  for (let i = 0; i < count && out.length < limit; i++) {
    const lon = lons[i];
    const lat = lats[i];
    if (lon >= minLon && lon <= maxLon && lat >= minLat && lat <= maxLat) {
      out.push([nameAt(i), lon, lat]);
    }
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
      const cities = query(
        msg.minLon,
        msg.minLat,
        msg.maxLon,
        msg.maxLat,
        msg.limit || DEFAULT_LIMIT,
      );
      self.postMessage({ type: "result", id: msg.id, cities });
      break;
    }
  }
};
