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
import { Fill, Style, RegularShape, Text, Stroke, Icon, Circle as CircleStyle } from "ol/style";
import { MVT } from "ol/format";
// Aliased so the global `Map` (used for diffing visible cities below) isn't
// shadowed by OL's `Map` class.
import { View, Map as OLMap } from "ol";
import { defaults as defaultInteractions } from "ol/interaction/defaults";
import MouseWheelZoom from "ol/interaction/MouseWheelZoom";
import { fromLonLat, toLonLat } from "ol/proj";
import { PMTiles } from "pmtiles";
import {
  CITY_NAVIGATION_DURATION_MS,
  zoomForCityPopulation,
} from "./navigation.mjs";

// `new URL(..., import.meta.url)` shares Parcel's asset pipeline with the
// `<link rel=preload>` tags in index.html, so the preload hash matches the
// runtime fetch hash and the browser de-dupes — the import.meta form is what
// Parcel statically rewrites to the same hashed path the HTML references.
const BACKGROUND_URL = new URL("./data/background.pmtiles", import.meta.url).href;
const CITIES_URL = new URL("./data/cities.bin", import.meta.url).href;
const VOLCANOES_URL = new URL("./data/volcanoes.bin", import.meta.url).href;
const SEAMOUNTS_URL = new URL("./data/seamounts.bin", import.meta.url).href;
const MEGALITHS_URL = new URL("./data/megaliths.bin", import.meta.url).href;
const FACTS_URL = new URL("./data/facts.bin", import.meta.url).href;
const CAVES_URL = new URL("./data/caves.bin", import.meta.url).href;
const CASTLES_URL = new URL("./data/castles.bin", import.meta.url).href;

/* ── theme ─────────────────────────────────────────────────────────────── */

// Period-correct palette: every tone is a tea-stained variation of the
// rag-paper base. No blues, greys, or saturated colours — those don't exist
// in pre-1850 hand-coloured engravings.
const COLOR_INK = "#1d1206";
const COLOR_LAND = "#E0C9A6";
const COLOR_WATER = "#F0DEC2";              // open water surface
const COLOR_GLACIER = "#F1E4C7";            // bone-white parchment
const COLOR_URBAN = "#C6A87C";              // built-up areas, notch darker than land
const COLOR_ROAD = "#6B3F18";               // warm sepia line
const COLOR_PARK = "#D3C3A1";               // protected lands, a touch greenier-tea
const COLOR_RANGE = "#C4A579";              // mountain ranges, notch darker than LAND
const COLOR_RANGE_DARK = "#A4895F";         // high peaks tint
const COLOR_PLATEAU = "#D2BB91";            // intermediate
const COLOR_DESERT = "#E7D2A6";             // a notch lighter / yellower than land

// Period-style wave hatching for water polygons. Antique engravers drew
// short wavy strokes in irregular patches — never a grid, never a continuous
// line. We reproduce that with a deterministic PRNG (so the pattern is
// identical every load): pick ~30 cluster positions from uniform noise,
// each cluster gets a randomised count of arcs, random arc lengths, random
// per-stroke alpha, slight ink colour drift. The result looks chaotic but
// the seed makes it harmonic and reproducible.
function mulberry32(seed) {
  return function () {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function makeWavePattern() {
  const tile = 256;
  const cnv = document.createElement("canvas");
  cnv.width = tile; cnv.height = tile;
  const ctx = cnv.getContext("2d");
  ctx.lineCap = "round";
  const rand = mulberry32(0xCAFEBABE);
  // Per-stroke colour drifts slightly within the warm-ink family so the
  // pattern doesn't look stamped. Alpha varies even more (some strokes
  // fade nearly to nothing — that's the engraver running low on ink).
  const drawWave = (x0, y0, len, amp, phase, dir) => {
    const r = 30 + Math.floor(rand() * 25);    // 30–55
    const g = 18 + Math.floor(rand() * 18);    // 18–36
    const b = 6  + Math.floor(rand() * 14);    // 6–20
    const alpha = 0.18 + rand() * 0.45;        // 0.18–0.63
    ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, ${alpha.toFixed(2)})`;
    ctx.lineWidth = 0.4 + rand() * 0.6;        // 0.4–1.0
    ctx.beginPath();
    for (let t = 0; t <= len; t++) {
      const u = t / len;
      // Stroke direction is mostly horizontal but tilted a few degrees
      // per cluster — that "hand-drawn" wobble gives the chaotic-yet-
      // harmonic feel.
      const dx = t * Math.cos(dir);
      const dy = t * Math.sin(dir) + Math.sin((u * Math.PI * 2) + phase) * amp;
      if (t === 0) ctx.moveTo(x0 + dx, y0 + dy);
      else ctx.lineTo(x0 + dx, y0 + dy);
    }
    ctx.stroke();
  };
  // 28 clusters scattered uniformly. Each cluster has 2–5 stacked arcs.
  // The tile is large (256 px) so the eye doesn't pick up the repeat
  // boundary even at low ocean zoom.
  const clusterCount = 28;
  for (let i = 0; i < clusterCount; i++) {
    const cx = rand() * tile;
    const cy = rand() * tile;
    const arcs = 2 + Math.floor(rand() * 4);   // 2–5 arcs per cluster
    const baseLen = 10 + rand() * 18;          // cluster arc-length seed
    const dir = (rand() - 0.5) * 0.25;          // ±~7° tilt per cluster
    for (let a = 0; a < arcs; a++) {
      const offX = (a - arcs / 2) * 2.5 + (rand() - 0.5) * 4;
      const offY = a * (2.5 + rand() * 1.5);
      const len = baseLen * (0.7 + rand() * 0.6);
      const amp = 1.0 + rand() * 1.4;
      const phase = rand() * Math.PI * 2;
      // Wrap-around at the tile edge so the repeat is seamless.
      drawWave((cx + offX + tile) % tile, (cy + offY + tile) % tile, len, amp, phase, dir);
    }
  }
  return ctx.createPattern(cnv, "repeat");
}
const wavePattern = makeWavePattern();
// Wave overlay is suppressed below this zoom — at world scale the strokes
// are sub-pixel and just add cost without visual benefit.
const WAVE_MIN_ZOOM = 3;

// Mountain hachure pattern — short downhill ink strokes that antique maps
// used to suggest steep ground. We use them as the "level lines" overlay
// on mountain-range polygons (geo_region featurecla = Range/mtn / Mountain
// / Highlands). PRNG-driven so the pattern is deterministic but doesn't
// look like a regular grid. Strokes get shorter at higher density so the
// densest patches read as "rugged, steep ground".
function makeHachurePattern() {
  const tile = 160;
  const cnv = document.createElement("canvas");
  cnv.width = tile; cnv.height = tile;
  const ctx = cnv.getContext("2d");
  ctx.lineCap = "round";
  const rand = mulberry32(0xBEEFC0DE);
  // Each hachure is a short stroke at slight orientation variation — the
  // engraver's strokes always pointed downhill, so we keep the angle
  // mostly vertical with small jitter. Stroke count tuned down from 180
  // to 110 to ease the per-tile fill cost; the visual density is similar
  // at the smaller tile size.
  const strokes = 110;
  for (let i = 0; i < strokes; i++) {
    const x = rand() * tile;
    const y = rand() * tile;
    const len = 2 + rand() * 5;            // 2–7 px
    const angle = (Math.PI / 2) + (rand() - 0.5) * 0.6;  // mostly vertical ±17°
    const dx = Math.cos(angle) * len;
    const dy = Math.sin(angle) * len;
    const alpha = 0.10 + rand() * 0.32;   // 0.10–0.42 — faint, layered
    const tone = 40 + Math.floor(rand() * 22);
    ctx.strokeStyle = `rgba(${tone - 10}, ${tone - 25}, ${tone - 35}, ${alpha.toFixed(2)})`;
    ctx.lineWidth = 0.45 + rand() * 0.45;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + dx, y + dy);
    ctx.stroke();
  }
  return ctx.createPattern(cnv, "repeat");
}
const hachurePattern = makeHachurePattern();
// Mountain hachure is invisible below this zoom (sub-pixel strokes) and
// paints a full-polygon Fill overlay so the cost adds up fast — push it
// to z 5 so it only renders when there's real screen area to draw into.
const HACHURE_MIN_ZOOM = 5;

// Antique "burning mountain" pictograph — the way 17th-c. atlases drew a
// volcano. Triple-peak silhouette in dark sepia ink, the central cone
// erupting with curling smoke plumes and a thin lava streak running down
// one flank. Hand-drawn proportions on purpose (the strokes don't quite
// line up, exactly as a copperplate engraving would look). 36×36 viewBox
// scaled at render time to the icon size; transparent background.
const VOLCANO_SVG_URL =
  "data:image/svg+xml;utf8," + encodeURIComponent(
    `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 36 36'>
       <g stroke='#2A1206' stroke-linecap='round' stroke-linejoin='round'>
         <!-- distant lesser peak (left) -->
         <path d='M0 32 L7 18 L13 27 Z' fill='#7A4318' stroke-width='1'/>
         <line x1='9'  y1='24' x2='10' y2='25' stroke-width='0.5'/>
         <line x1='8'  y1='27' x2='10' y2='28' stroke-width='0.5'/>
         <!-- distant lesser peak (right) -->
         <path d='M23 32 L29 20 L36 32 Z' fill='#7A4318' stroke-width='1'/>
         <line x1='27' y1='24' x2='28' y2='25' stroke-width='0.5'/>
         <line x1='29' y1='27' x2='30' y2='28' stroke-width='0.5'/>
         <!-- main volcanic cone, notched crater -->
         <path d='M5 33 L15 10 L17 13 L18 10 L19 13 L21 10 L31 33 Z' fill='#8B4A1F' stroke-width='1.5'/>
         <!-- engraved cross-hatching down the right flank for shading -->
         <line x1='22' y1='14' x2='24' y2='17' stroke-width='0.55'/>
         <line x1='23' y1='18' x2='25' y2='21' stroke-width='0.55'/>
         <line x1='24' y1='22' x2='26' y2='25' stroke-width='0.55'/>
         <line x1='25' y1='26' x2='27' y2='29' stroke-width='0.55'/>
         <line x1='26' y1='30' x2='28' y2='32' stroke-width='0.55'/>
         <!-- secondary hatching on the left flank, fainter -->
         <line x1='11' y1='20' x2='13' y2='22' stroke-width='0.45' stroke='#3a1f0a'/>
         <line x1='10' y1='24' x2='12' y2='26' stroke-width='0.45' stroke='#3a1f0a'/>
         <line x1='9'  y1='28' x2='11' y2='30' stroke-width='0.45' stroke='#3a1f0a'/>
         <!-- crater rim shadow line -->
         <path d='M14.5 12 L21.5 12' fill='none' stroke='#1d1206' stroke-width='0.9'/>
         <!-- lava streak curling down the right flank -->
         <path d='M20 12 C 22 17, 22 21, 24 25 C 25 28, 25 30, 27 32' fill='none' stroke='#A13012' stroke-width='1.3'/>
         <path d='M20 12 C 21 14, 21 16, 21.5 18' fill='none' stroke='#D85020' stroke-width='0.7'/>
         <!-- smoke billow — three curling plumes, growing wider as they rise -->
         <path d='M15 10 C 12 8, 14 5, 11 1' fill='none' stroke='#5A4030' stroke-width='1.4' opacity='0.55'/>
         <path d='M18 10 C 19 7, 17 4, 19 0' fill='none' stroke='#5A4030' stroke-width='1.6' opacity='0.6'/>
         <path d='M21 10 C 24 8, 22 4, 25 0' fill='none' stroke='#5A4030' stroke-width='1.3' opacity='0.5'/>
         <!-- embers near the crater -->
         <circle cx='16' cy='12' r='0.7' fill='#D85020' stroke='none'/>
         <circle cx='19' cy='11.5' r='0.55' fill='#FFB050' stroke='none'/>
         <circle cx='21' cy='13' r='0.5' fill='#E8651F' stroke='none'/>
       </g>
     </svg>`,
  );

// Period-style castle pictograph. Two flanking towers with conical roofs
// frame a central keep with battlements. Pennant on the tallest tower,
// arched gate below. Engraved hatching on stonework for shading. 36×36
// viewBox/anchor convention shared with the other pictographs.
const CASTLE_SVG_URL =
  "data:image/svg+xml;utf8," + encodeURIComponent(
    `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 36 36'>
       <g stroke='#2A1206' stroke-linecap='round' stroke-linejoin='round'>
         <!-- right round tower body -->
         <path d='M25 30 L25 12 Q25 9 28 9 Q31 9 31 12 L31 30 Z' fill='#8C6233' stroke-width='1.3'/>
         <!-- right tower conical roof -->
         <path d='M24 12 L28 4 L32 12 Z' fill='#5D2C10' stroke-width='1.1'/>
         <!-- right tower slit window -->
         <line x1='28' y1='16' x2='28' y2='19' stroke-width='1.4'/>
         <!-- right tower stone hatching -->
         <line x1='26.5' y1='22' x2='27.5' y2='22' stroke-width='0.4'/>
         <line x1='28.5' y1='22' x2='29.5' y2='22' stroke-width='0.4'/>
         <line x1='26.5' y1='26' x2='27.5' y2='26' stroke-width='0.4'/>
         <line x1='28.5' y1='26' x2='29.5' y2='26' stroke-width='0.4'/>
         <!-- central keep -->
         <path d='M9 30 L9 16 L11 16 L11 13 L13 13 L13 16 L15 16 L15 13 L17 13 L17 16 L19 16 L19 13 L21 13 L21 16 L23 16 L23 13 L25 13 L25 16 L25 30 Z' fill='#A07845' stroke-width='1.3'/>
         <!-- gateway at the centre -->
         <path d='M15 30 L15 24 Q15 21 18 21 Q21 21 21 24 L21 30' fill='#1d1206' stroke-width='0.8'/>
         <!-- portcullis bars -->
         <line x1='15' y1='27' x2='21' y2='27' stroke='#7a3d15' stroke-width='0.4'/>
         <line x1='17' y1='22' x2='17' y2='30' stroke='#7a3d15' stroke-width='0.4'/>
         <line x1='19' y1='22' x2='19' y2='30' stroke='#7a3d15' stroke-width='0.4'/>
         <!-- left round tower body (taller than right) -->
         <path d='M2 30 L2 10 Q2 7 5 7 Q8 7 8 10 L8 30 Z' fill='#8C6233' stroke-width='1.3'/>
         <!-- left tower conical roof -->
         <path d='M1 10 L5 1 L9 10 Z' fill='#5D2C10' stroke-width='1.1'/>
         <!-- flag pole + pennant on tallest tower -->
         <line x1='5' y1='1' x2='5' y2='-2' stroke-width='0.7'/>
         <path d='M5 -1 L10 0 L5 1.5 Z' fill='#7a3d15' stroke-width='0.5'/>
         <!-- left tower slit window -->
         <line x1='5' y1='14' x2='5' y2='17' stroke-width='1.4'/>
         <!-- left tower stone hatching -->
         <line x1='3' y1='20' x2='4' y2='20' stroke-width='0.4'/>
         <line x1='6' y1='20' x2='7' y2='20' stroke-width='0.4'/>
         <line x1='3' y1='24' x2='4' y2='24' stroke-width='0.4'/>
         <line x1='6' y1='24' x2='7' y2='24' stroke-width='0.4'/>
         <line x1='3' y1='28' x2='4' y2='28' stroke-width='0.4'/>
         <line x1='6' y1='28' x2='7' y2='28' stroke-width='0.4'/>
         <!-- keep stone hatching -->
         <line x1='10' y1='19' x2='11' y2='19' stroke-width='0.4'/>
         <line x1='13' y1='19' x2='14' y2='19' stroke-width='0.4'/>
         <line x1='22' y1='19' x2='23' y2='19' stroke-width='0.4'/>
       </g>
     </svg>`,
  );

// Cave pictograph — an arched opening in a rocky hillside, with engraver's
// hatching down both flanks and small boulders flanking the entrance.
// Period maps usually labelled caves "antrum" or "spelunca" rather than
// drawing them, but the hollow opening reads instantly at glance scale
// without needing a label.
const CAVE_SVG_URL =
  "data:image/svg+xml;utf8," + encodeURIComponent(
    `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 36 36'>
       <g stroke='#2A1206' stroke-linecap='round' stroke-linejoin='round'>
         <!-- rocky hillside silhouette -->
         <path d='M2 32 L3 16 Q8 5 18 4 Q28 5 33 16 L34 32 Z' fill='#A78656' stroke-width='1.5'/>
         <!-- ridge highlight along the brow -->
         <path d='M3 16 Q8 8 18 7 Q28 8 33 16' fill='none' stroke='#7a5a32' stroke-width='0.8'/>
         <!-- cave mouth (the void) -->
         <path d='M10 32 L10 22 Q10 14 18 14 Q26 14 26 22 L26 32 Z' fill='#1d1206' stroke-width='1.2'/>
         <!-- left flank engraver's hatching -->
         <line x1='5'  y1='12' x2='7'  y2='14' stroke-width='0.55'/>
         <line x1='4'  y1='16' x2='7'  y2='19' stroke-width='0.55'/>
         <line x1='4'  y1='20' x2='7'  y2='23' stroke-width='0.55'/>
         <line x1='4'  y1='24' x2='7'  y2='27' stroke-width='0.55'/>
         <line x1='4'  y1='28' x2='6'  y2='30' stroke-width='0.55'/>
         <!-- right flank engraver's hatching -->
         <line x1='31' y1='12' x2='29' y2='14' stroke-width='0.55'/>
         <line x1='32' y1='16' x2='29' y2='19' stroke-width='0.55'/>
         <line x1='32' y1='20' x2='29' y2='23' stroke-width='0.55'/>
         <line x1='32' y1='24' x2='29' y2='27' stroke-width='0.55'/>
         <line x1='32' y1='28' x2='30' y2='30' stroke-width='0.55'/>
         <!-- stalactites hanging from the cave mouth -->
         <path d='M12.5 14 L13   16.5 L13.5 14 Z' fill='#A78656' stroke-width='0.4'/>
         <path d='M15.5 14 L16   17   L16.5 14 Z' fill='#A78656' stroke-width='0.4'/>
         <path d='M19   14 L19.5 16.5 L20   14 Z' fill='#A78656' stroke-width='0.4'/>
         <path d='M22.5 14 L23   17   L23.5 14 Z' fill='#A78656' stroke-width='0.4'/>
         <!-- boulders flanking the cave mouth -->
         <ellipse cx='8'  cy='30' rx='2'   ry='1.1' fill='#8C6233' stroke-width='0.6'/>
         <ellipse cx='28' cy='30' rx='2.4' ry='1.3' fill='#8C6233' stroke-width='0.6'/>
       </g>
     </svg>`,
  );

// Mountain pictograph — used for the peak features baked into the
// background tiles. Two-peak silhouette with shaded right faces, a snow
// cap on the taller summit, and downhill hatching for the period engraver
// look. The peak style below caches one Icon instance per tier so the
// same SVG is reused at multiple sizes.
const MOUNTAIN_SVG_URL =
  "data:image/svg+xml;utf8," + encodeURIComponent(
    `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'>
       <g stroke='#2A1206' stroke-linecap='round' stroke-linejoin='round'>
         <!-- background lesser peak -->
         <path d='M1 20 L6 10 L11 20 Z' fill='#A07845' stroke-width='1.1'/>
         <path d='M6 10 L8 14 L11 20 Z' fill='#7a5a32' stroke-width='0.6'/>
         <!-- main peak -->
         <path d='M7 21 L14 4 L21 21 Z' fill='#8C6233' stroke-width='1.3'/>
         <!-- shaded right face -->
         <path d='M14 4 L17 12 L21 21 Z' fill='#5d3f1f' stroke-width='0.7'/>
         <!-- snow cap on the main peak -->
         <path d='M12.5 7 L14 4 L15.5 7 L14.5 6.5 L14 7 L13.5 6.5 Z' fill='#F1E4C7' stroke-width='0.4'/>
         <!-- engraver's downhill hatching on the left slope -->
         <line x1='9'  y1='15' x2='10' y2='17' stroke-width='0.4'/>
         <line x1='10' y1='12' x2='11' y2='14' stroke-width='0.4'/>
         <line x1='11' y1='10' x2='12' y2='12' stroke-width='0.4'/>
         <!-- hatching on the right slope -->
         <line x1='16' y1='10' x2='17' y2='12' stroke-width='0.4'/>
         <line x1='17' y1='13' x2='18' y2='15' stroke-width='0.4'/>
         <line x1='18' y1='16' x2='19' y2='18' stroke-width='0.4'/>
       </g>
     </svg>`,
  );

// Stepped bathymetry ramp (11 bands). Calibrated by eye against period
// atlases: shelf 200m is barely a shade darker than the open water, then
// each band steps toward a dusky ink-blue at 10 km. The renderer paints in
// stacking order (deepest first; z-index baked below), so each shallower
// band over-paints the deeper ones inside its perimeter.
const BATHY_COLORS = {
  bathy_200:   "#E7D2B3",
  bathy_1000:  "#DAC4A2",
  bathy_2000:  "#CDB591",
  bathy_3000:  "#C0A680",
  bathy_4000:  "#B19770",
  bathy_5000:  "#A38961",
  bathy_6000:  "#947B53",
  bathy_7000:  "#866E47",
  bathy_8000:  "#76603A",
  bathy_9000:  "#664F2C",
  bathy_10000: "#4E3B1C",
};
// Higher zIndex = painted later = on top. We want shallow on top so the
// gradient reads correctly.
const BATHY_Z = {
  bathy_10000: 10,
  bathy_9000:  11,
  bathy_8000:  12,
  bathy_7000:  13,
  bathy_6000:  14,
  bathy_5000:  15,
  bathy_4000:  16,
  bathy_3000:  17,
  bathy_2000:  18,
  bathy_1000:  19,
  bathy_200:   20,
};

// City count caps — gradual climb at low zoom, hard jump at z=8 where
// streets become visible, and a SECOND hard jump at z=18 where the user
// wants every named place on the map. Super-capitals (pop ≥ 1 M) are
// added on top of these as the always-render floor.
//
//   zoom |   limit  |  effect
//   -----+----------+----------------------------------------------
//     2  |     30   |  ~30 megacities globally (Tokyo, Delhi, …)
//     4  |    100   |  + major regional cities
//     6  |    300   |  + medium cities, gradual increase
//     8  |   1200   |  hard jump — streets-visible scale needs density
//    12  |   5000   |  city scale, every named municipality
//    14  |  15000   |  intermediate climb
//    17  |  60000   |  z=15–17 — most of the bin
//   >17  | 150000   |  HARD jump for z ≥ 18 — every named place in
//                       cities500.bin within reach of declutter
const CITY_LIMITS = [
  { maxZoom: 2, limit: 30 },
  { maxZoom: 4, limit: 100 },
  { maxZoom: 6, limit: 300 },
  { maxZoom: 8, limit: 1200 },
  { maxZoom: 12, limit: 5000 },
  { maxZoom: 14, limit: 15000 },
  { maxZoom: 17, limit: 60000 },
  { maxZoom: 22, limit: 150000 },
];
function cityLimitFor(zoom) {
  for (const t of CITY_LIMITS) if (zoom <= t.maxZoom) return t.limit;
  return CITY_LIMITS[CITY_LIMITS.length - 1].limit;
}
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

// Half-zoom snap. Default `constrainResolution` snaps to integer zoom
// levels (the tile cache's native resolutions). Going from z 2 → z 3 in
// one click feels coarse — that's a 2× resolution change per snap. With
// half-zoom steps (z 2 / 2.5 / 3 / 3.5 / 4 …) each snap is √2 ≈ 1.41×,
// which reads as a fluid motion. Each intermediate level still uses the
// closest integer tile from the cache scaled by 2^0.5 ≈ 1.41, so the
// perf budget is unchanged. ZOOM_MAX extended to 25 so the GPS fly-to
// (and aggressive wheel zoom-in) can reach street-level detail.
const PIXELS_PER_TILE = 256;
const MAX_RESOLUTION = 2 * MERCATOR_Y_MAX / PIXELS_PER_TILE;
const ZOOM_STEPS_PER_LEVEL = 2;  // → 0.5 zoom step granularity
const ZOOM_MAX = 25;
const RESOLUTIONS = [];
for (let i = 0; i <= ZOOM_MAX * ZOOM_STEPS_PER_LEVEL; i++) {
  RESOLUTIONS.push(MAX_RESOLUTION / Math.pow(2, i / ZOOM_STEPS_PER_LEVEL));
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
  // Snap to one of the precomputed half-zoom resolutions after each
  // interaction. The tile cache is still keyed by integer (z, x, y); a
  // half-step zoom just blits the nearest integer tile at the matching
  // scale, so the perf budget is the same and zoom feels much finer.
  constrainResolution: true,
  resolutions: RESOLUTIONS,
  // Hard ceiling. RESOLUTIONS already stops at z=25, but maxZoom guards
  // against any future code path (programmatic animate, hash, etc.)
  // overshooting. At z=25 the viewport is ~10 m wide so it's the
  // practical ceiling anyway.
  maxZoom: ZOOM_MAX,
});

const map = new OLMap({
  target: mapElement,
  controls: [],
  view,
  // Wheel-zoom animation tuned to feel snappy but unhurried. Was 250 ms
  // (OL default) then 120 ms during the worst of the lag; now that the
  // overlays are hidden during interaction and zoom snaps to a quarter-
  // step resolution, we can afford a slightly longer animation so the
  // smooth transition reads as deliberate motion rather than a snap.
  interactions: defaultInteractions({ mouseWheelZoom: false }).extend([
    new MouseWheelZoom({ duration: 180 }),
  ]),
});

// Toggle a `map-interacting` class on body during pan/zoom so the CSS in
// index.html can hide the mix-blend-mode parchment overlays. The overlays
// are the dominant per-frame GPU cost at low zoom (two fullscreen
// compositor blend passes against the animated map canvas). Removing
// them during interaction is the single biggest perf win for the
// z<4 zoom-in/out experience; the brief absence is barely perceptible
// during fast motion, and they snap back the moment the user stops.
let interactingTimer = 0;
map.on("movestart", () => {
  document.body.classList.add("map-interacting");
  clearTimeout(interactingTimer);
});
map.on("moveend", () => {
  // Small delay so a quick wheel-flick (multiple movestart/moveend pairs)
  // doesn't flash the overlays back on between steps.
  interactingTimer = setTimeout(() => {
    document.body.classList.remove("map-interacting");
  }, 120);
});

mapElement.style.backgroundColor = COLOR_WATER;

/* ── paper noise locked to the map ─────────────────────────────────────
   The parchment overlays (#paper, #foxing) are anchored to a virtual
   world point so they pan and scale with the map instead of staying
   glued to the viewport. Sync runs on moveend only — during interaction
   the overlays are hidden via the `map-interacting` class, so there is
   nothing to keep up to date until motion settles.
*/
const paperLayers = [
  { el: document.getElementById("paper"),  baseSize: 600 },
  { el: document.getElementById("foxing"), baseSize: 0   }, // foxing uses % positions; only sync translation
];
// Reference resolution — what the noise was originally designed for. We
// pick z=2 (Web Mercator) so the parchment is visible at world scale
// without becoming gargantuan when the user zooms into a city.
const PAPER_BASE_RES = 2 * MERCATOR_Y_MAX / 256 / 4; // ≈ resolution at zoom 2
function syncPaperToMap() {
  const center = view.getCenter();
  const res = view.getResolution();
  if (!center || !res) return;
  const size = map.getSize();
  if (!size) return;
  const cx = size[0] / 2 - center[0] / res;
  const cy = size[1] / 2 + center[1] / res; // y is inverted: mercator north is positive, screen north is negative
  // Texture scale: larger when zoomed out, smaller when zoomed in. Bound
  // it tightly — without clamping, the grain balloons into screen-sized
  // patches at street-level zooms (where you'd be looking at the paper
  // through a magnifier, but the noise has finite real-world detail).
  // Clamp to roughly 0.5×–3× so the grain feels attached to the parchment
  // but never collapses into one giant blob or becomes a pixel-level grid.
  const rawScale = PAPER_BASE_RES / res;
  const scale = Math.max(0.5, Math.min(3, rawScale));
  for (const layer of paperLayers) {
    if (!layer.el) continue;
    if (layer.baseSize > 0) {
      const tile = layer.baseSize * scale;
      // Modulo the tile so the position numbers stay finite at deep zoom.
      const x = ((cx % tile) + tile) % tile - tile;
      const y = ((cy % tile) + tile) % tile - tile;
      layer.el.style.backgroundSize = `${tile}px ${tile}px`;
      layer.el.style.backgroundPosition = `${x}px ${y}px`;
    } else {
      // No tile size means it's the foxing layer (CSS gradients with %
      // positions). We translate it so the spots still drift with the map,
      // but they don't need to scale — they're a fixed pattern on the page.
      layer.el.style.transform = `translate(${cx % 800}px, ${cy % 800}px)`;
    }
  }
}
map.on("moveend", syncPaperToMap);
// One initial sync once the map has a size.
map.once("postrender", syncPaperToMap);

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
  // Two style variants per bathymetry band — the wave-pattern overlay
  // adds cost (CanvasPattern fill repaint per tile) and is invisible at
  // low zoom where the strokes go sub-pixel, so the dispatch function
  // picks the cheap variant when zoomed out and the full variant when
  // the pattern actually contributes pixels.
  //
  // Each band also carries a SOFT BAND-EDGE STROKE that matches the
  // colour of the NEXT-DEEPER band — at the polygon boundary the colour
  // therefore feathers from this band's fill toward the band beyond it,
  // which reads as a smooth depth gradient instead of the previous
  // crisp stepping. The deepest band uses its own colour for the stroke
  // (nothing deeper to feather toward).
  const bathyStylesNoWaves = {};
  const bathyStylesWithWaves = {};
  const bathyDepths = [200, 1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000, 10000];
  for (const cls of Object.keys(BATHY_COLORS)) {
    const z = BATHY_Z[cls];
    const depth = Number(cls.split("_")[1]);
    const next = bathyDepths.find((d) => d > depth);
    const nextColor = next ? BATHY_COLORS[`bathy_${next}`] : BATHY_COLORS[cls];
    const colourStyle = new Style({
      zIndex: z,
      fill: new Fill({ color: BATHY_COLORS[cls] }),
      // 2 px feather toward the next-deeper colour — without the stroke,
      // adjacent band polygons paint with a crisp colour seam at the
      // 200/1000/2000/… isobaths. The matched-deeper stroke turns those
      // seams into a soft gradient join.
      stroke: new Stroke({ color: nextColor, width: 2 }),
    });
    const waveStyle = new Style({ zIndex: z + 50, fill: new Fill({ color: wavePattern }) });
    bathyStylesNoWaves[cls] = colourStyle;
    bathyStylesWithWaves[cls] = [colourStyle, waveStyle];
  }
  // Land "ink halo" is the most expensive feature in the renderer: every
  // coastline polygon gets stroked once per width, and each fat stroke
  // covers a lot of fill pixels. At low zoom the outer halo widths (up
  // to 31 px) span huge fractions of the visible viewport, so stroking
  // the world coastline nine times is what made world-view zoom slow.
  // We tier the halo by zoom: at world view we paint the fill plus one
  // thin outline (the outer halos go sub-coastline and contribute
  // basically nothing); the full nine-stroke stack only kicks in past
  // z 6 where the halo widths actually read as a soft glow.
  const landFlat = [
    new Style({ zIndex: 309, stroke: new Stroke({ color: COLOR_INK, width: 1.5 }) }),
    new Style({ zIndex: 310, fill: new Fill({ color: COLOR_LAND }) }),
  ];
  const landMid = [
    new Style({ zIndex: 305, stroke: new Stroke({ color: COLOR_INK, width: 9 }) }),
    new Style({ zIndex: 306, stroke: new Stroke({ color: COLOR_WATER, width: 8 }) }),
    new Style({ zIndex: 307, stroke: new Stroke({ color: COLOR_INK, width: 4 }) }),
    new Style({ zIndex: 308, stroke: new Stroke({ color: COLOR_WATER, width: 3 }) }),
    new Style({ zIndex: 309, stroke: new Stroke({ color: COLOR_INK, width: 1.5 }) }),
    new Style({ zIndex: 310, fill: new Fill({ color: COLOR_LAND }) }),
  ];
  const landFull = [
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
  const landForZoom = (z) => (z < 3 ? landFlat : z < 6 ? landMid : landFull);
  // Geography region polygons (mountain ranges, plateaus, basins, deserts).
  // Mountain-class regions get an additional hachure-pattern overlay above
  // the base tint — the engraved "downhill strokes" that period mapmakers
  // used to indicate rugged ground. Hachure only kicks in past zoom 4 (it's
  // sub-pixel below that).
  const regionFill = {
    "Range/mtn":  COLOR_RANGE,
    "Range":      COLOR_RANGE,
    "Mountains":  COLOR_RANGE,
    "Mtn range":  COLOR_RANGE,
    "Mt":         COLOR_RANGE_DARK,
    "Mountain":   COLOR_RANGE_DARK,
    "Highlands":  COLOR_RANGE,
    "Plateau":    COLOR_PLATEAU,
    "Basin":      COLOR_PLATEAU,
    "Lowland":    COLOR_LAND,
    "Plain":      COLOR_LAND,
    "Desert":     COLOR_DESERT,
    "Tundra":     COLOR_LAND,
  };
  const MOUNTAIN_CLASSES = new Set([
    "Range/mtn", "Range", "Mountains", "Mtn range", "Mt", "Mountain", "Highlands",
  ]);
  // Cache by (featurecla, hasName, hasHachure) — tiny set of combinations.
  const regionStyleCache = new Map();
  const regionHachureStyle = new Style({
    zIndex: 321,
    fill: new Fill({ color: hachurePattern }),
  });
  function regionStyleFor(featurecla, name, useHachure) {
    const color = regionFill[featurecla];
    if (!color) return null;
    const key = `${featurecla}|${useHachure ? "h" : ""}`;
    let base = regionStyleCache.get(key);
    if (!base) {
      base = new Style({
        zIndex: 320,
        fill: new Fill({ color }),
        stroke: new Stroke({ color: COLOR_INK, width: 0.35 }),
        text: new Text({
          font: 'italic 13px "IM Fell English"',
          fill: new Fill({ color: "rgba(45,28,8,0.7)" }),
          stroke: new Stroke({ color: "rgba(240,222,194,0.8)", width: 2 }),
          text: "",
          textAlign: "center",
          overflow: false,
        }),
      });
      regionStyleCache.set(key, base);
    }
    base.getText().setText(name || "");
    return useHachure && MOUNTAIN_CLASSES.has(featurecla) ? [base, regionHachureStyle] : base;
  }
  const park = new Style({
    zIndex: 330,
    fill: new Fill({ color: COLOR_PARK }),
    stroke: new Stroke({ color: "rgba(60,40,15,0.45)", width: 0.5, lineDash: [3, 3] }),
  });
  // Marine labels: with wrapX=true the source renders into every world copy
  // intersecting the viewport, which made labels like "Arctic Ocean" appear
  // twice near z=1. The geometry function pulls the label into the world
  // copy nearest view center on every wrapped rendering, so they all land at
  // the same absolute position and declutter dedupes them down to one.
  const marinePoint = new Point([0, 0]);
  const marine = new Style({
    zIndex: 400,
    geometry: (feature) => {
      // labelX/labelY are baked at build time (polylabel pole-of-
      // inaccessibility on the full polygon, in EPSG:3857 metres) so every
      // tile-clipped copy of "Atlantic Ocean" carries the same anchor.
      // Snapping to nearest world copy puts them all at the same absolute
      // pixel position, and OL's declutter then keeps only one — that's
      // how we dedup labels across tiles without runtime bookkeeping.
      // Falls back to the tile-clip bbox centroid only if the archive
      // pre-dates the AOT polylabel pass.
      let fx = feature.get("labelX");
      let fy = feature.get("labelY");
      if (fx == null || fy == null) {
        const ext = feature.getGeometry().getExtent();
        fx = (ext[0] + ext[2]) / 2;
        fy = (ext[1] + ext[3]) / 2;
      }
      const viewCenter = view.getCenter();
      const cx = viewCenter ? viewCenter[0] : 0;
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
  // Rivers — bumped from 1 px to 1.4 px with a slight sepia tint so they
  // read against the bathy tones at world view. The thin pure-ink stroke
  // disappeared into the brown background and rivers felt absent.
  const river = new Style({
    zIndex: 600,
    stroke: new Stroke({ color: "#3b1f08", width: 1.4 }),
  });
  // Lakes — same two-variant trick as bathymetry. Cheap variant (no wave
  // overlay) at world scale, full hatching once we're zoomed in enough
  // for the strokes to actually be visible.
  const lakeColourStyle = new Style({
    zIndex: 700,
    fill: new Fill({ color: COLOR_WATER }),
    stroke: new Stroke({ color: COLOR_INK, width: 1 }),
  });
  const lakeWaveStyle = new Style({ zIndex: 701, fill: new Fill({ color: wavePattern }) });
  const lakeNoWaves = lakeColourStyle;
  const lakeWithWaves = [lakeColourStyle, lakeWaveStyle];
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
  // Mountain peaks: small two-peak pictograph (MOUNTAIN_SVG_URL above),
  // the same engraver vocabulary as the volcano / castle / cave icons.
  // The icon is sized by elevation tier so the Himalayas overshadow a
  // foothill. Cached per tier so the style function isn't re-allocating
  // an Icon on every tile render.
  const PEAK_LABEL_MIN_ZOOM = 5;
  const peakStyleCache = new Map();
  function peakStyles(elev) {
    const tier = Math.max(0, Math.min(8, Math.floor((elev || 0) / 1000)));
    const cached = peakStyleCache.get(tier);
    if (cached) return cached;
    // 14 px at sea level → 30 px for an 8 km peak.
    const px = 14 + tier * 2;
    const icon = new Icon({
      src: MOUNTAIN_SVG_URL,
      width: px,
      height: px,
      anchor: [0.5, 0.85], // base of the mountain sits on the lat/lon point
      rotateWithView: false,
    });
    const styles = [
      new Style({ zIndex: 850 + tier, image: icon, declutterMode: "none" }),
    ];
    peakStyleCache.set(tier, styles);
    return styles;
  }
  // Label fill/stroke are shared (one Fill per ramp tier would be overkill);
  // text content is per-feature so OL declutter sees each name distinctly.
  const peakLabelFill = new Fill({ color: COLOR_INK });
  const peakLabelStroke = new Stroke({ color: COLOR_LAND, width: 2 });
  // MVT RenderFeatures don't have `set()`, so cache styles in a WeakMap
  // keyed on the feature. Same idea as marineInteriorCache above.
  const peakLabeledStyleCache = new WeakMap();

  // Sub-pixel skip — the existing PMTiles archive carries every NaturalEarth
  // lake / glacier / land polygon at every zoom (~3000 features in the world
  // tile, 90% of which are sub-pixel ponds and islets that just burn render
  // budget). Until the archive is rebuilt with the new area-based minzoom
  // gates in build-data.mjs, the style fn rejects features whose on-screen
  // extent would be < ~0.5 px² — exactly the features tippecanoe will drop
  // post-rebuild, so the behaviour is the same in both regimes.
  function isSubPixel(feature, res, minPxArea) {
    const ext = feature.getGeometry().getExtent();
    const w = (ext[2] - ext[0]) / res;
    const h = (ext[3] - ext[1]) / res;
    return w * h < minPxArea;
  }

  return function (feature) {
    const cls = feature.get("featureClass");
    const z = view.getZoom() ?? 0;
    const res = view.getResolution() ?? 1;
    const showWaves = z >= WAVE_MIN_ZOOM;
    if (cls && cls.startsWith("bathy_")) {
      // Same sub-pixel skip as lake/glacier/land — bathy bands carry a long
      // tail of tiny mid-ocean ridges that are sub-pixel at z<5 but still
      // hit the style + fill path. The AOT build now gates these too, but
      // this runtime guard keeps the pre-rebuild archive snappy.
      if (z < 5 && isSubPixel(feature, res, 1)) return null;
      return (showWaves ? bathyStylesWithWaves : bathyStylesNoWaves)[cls];
    }
    switch (cls) {
      case "glacier":
        if (z < 4 && isSubPixel(feature, res, 0.5)) return null;
        return glacier;
      case "lake":
        if (z < 4 && isSubPixel(feature, res, 0.5)) return null;
        return showWaves ? lakeWithWaves : lakeNoWaves;
      case "land":
        if (z < 4 && isSubPixel(feature, res, 0.5)) return null;
        return landForZoom(z);
      case "park": return park;
      case "geo_region":
        return regionStyleFor(feature.get("featurecla"), feature.get("name"), z >= HACHURE_MIN_ZOOM);
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
        const dots = peakStyles(elev);
        if (z < PEAK_LABEL_MIN_ZOOM) return dots;
        // Per-feature Text so each peak's label keeps its own string
        // through declutter (same reason as the city labels above). Cached
        // in a WeakMap so we don't allocate a Text + Style + array every
        // render frame for every visible peak — used to be one of the
        // hottest allocations at z 5+ where dozens of peaks are visible.
        let styles = peakLabeledStyleCache.get(feature);
        if (!styles) {
          const name = feature.get("name") || "";
          const text = new Text({
            font: 'italic 11px "IM Fell English"',
            textAlign: "left",
            offsetX: 9,
            offsetY: 1,
            fill: peakLabelFill,
            stroke: peakLabelStroke,
            text: elev ? `${name} · ${elev} m` : name,
          });
          styles = [...dots, new Style({ zIndex: 851, text })];
          peakLabeledStyleCache.set(feature, styles);
        }
        return styles;
      }
    }
  };
}

// PMTiles archive — a single HTTP fetch with byte-range requests for tile
// data. The MVT layer name is exposed to the style function via the
// `layerName: "featureClass"` option, matching the legacy property name.
const pmtilesArchive = new PMTiles(BACKGROUND_URL);

// Enumerated MVT layer set. Each VectorTileSource declares the exact MVT
// layers it wants from the PMTiles archive so the MVT decoder skips the
// others entirely (instead of parsing every feature and throwing most of
// them away in the layer's style function). Without this, the marine
// source — which only renders a handful of ocean labels — was decoding
// the full bathymetry stack + every land/lake/river/road feature for
// every tile, then the style filter dropped them all.
const BACKGROUND_MVT_LAYERS = [
  "bathy_200", "bathy_1000", "bathy_2000", "bathy_3000", "bathy_4000",
  "bathy_5000", "bathy_6000", "bathy_7000", "bathy_8000", "bathy_9000",
  "bathy_10000",
  "glacier", "lake", "land", "park", "geo_region",
  "river_detail", "river", "urban_area", "road", "sea_route", "peak",
];
const MARINE_MVT_LAYERS = ["marine"];

// One factory, two sources: the main background wraps horizontally so the
// world repeats during pan, while marine labels live on a non-wrapping
// source so we can place them in exactly one world copy (the one nearest
// view center, picked by the marine style's geometry override).
function makeBackgroundSource(wrapX, mvtLayers) {
  const src = new VectorTileSource({
    format: new MVT({ layerName: "featureClass", layers: mvtLayers }),
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

const backgroundSource = makeBackgroundSource(true, BACKGROUND_MVT_LAYERS);
const marineSource = makeBackgroundSource(false, MARINE_MVT_LAYERS);

const styleDispatch = backgroundLayerStyle();
// preload was 1 (keep one zoom level ahead warm). At low zoom that turned
// into "materialise the world view at the next zoom out too" — fetching
// PMTiles entries and decoding MVT for tiles the user may never reach,
// blocking the main thread mid-animation. 0 means we render only what the
// current view needs; OL's tile cache still keeps recently-used tiles
// warm so wheel zoom in/out usually hits cache anyway.
const backgroundLayer = new VectorTileLayer({
  declutter: true,
  preload: 0,
  // renderBuffer = how many extra screen pixels around the viewport edge
  // OL keeps rendered. Bigger reduces "missing edge" flashes when panning,
  // but every pixel costs paint time. 80 is enough to hide the join,
  // significantly cheaper than 128 — biggest win for low-zoom pan perf
  // because at z=0 every fill covers the world plus that buffer.
  renderBuffer: 80,
  // cacheSize: keep up to 64 rasterized tiles warm per layer. Default
  // (auto-grow to two zoom levels) was discarding the z=0 / z=1 tiles
  // as soon as the user zoomed past them, so every zoom-out paid the
  // full re-rasterize. 64 covers world-view + a few intermediate zooms
  // simultaneously; memory cost is bounded by tile area at native pixel
  // density (~1 MB / tile worst case → ~64 MB peak), acceptable for the
  // big perf win on repeated zoom in/out.
  cacheSize: 64,
  source: backgroundSource,
  style: styleDispatch,
});
map.addLayer(backgroundLayer);

const marineLayer = new VectorTileLayer({
  declutter: true,
  preload: 0,
  renderBuffer: 80,
  cacheSize: 64,
  source: marineSource,
  style: styleDispatch,
});
map.addLayer(marineLayer);

/* ── features layer (cities) ──────────────────────────────────────────── */

// City marker: just the name, centered on the point. No dot. The label
// IS the identity. The previous design (small black dot + label above)
// left orphan black dots scattered across the map whenever declutter
// culled a label, which looked broken. With name-as-marker, declutter
// either keeps both name and presence, or hides the city entirely.
const cityTextFill = new Fill({ color: "rgba(0,0,0,1)" });
const cityTextStroke = new Stroke({ color: "rgba(224,201,166,1)", width: 2.5 });

function makeCityStyles(name, isSelected, population) {
  // Capitals look identical to non-capitals — no leading glyph, no bold,
  // no font-size bump. Capitals still render unconditionally when they're
  // super-capitals (pop ≥ 1 M) because we route those to the alwaysLayer
  // upstream; the styling itself just doesn't call them out.
  //
  // A searched city is bold and lives on the non-decluttered layer so its
  // name remains readable at the destination zoom.
  const fontSpec = isSelected
    ? 'bold 16px "IM Fell English"'
    : '12px "IM Fell English"';
  const text = new Text({
    font: fontSpec,
    textAlign: "center",
    textBaseline: "middle",
    offsetX: 0,
    offsetY: 0,
    fill: cityTextFill,
    stroke: cityTextStroke,
    text: name,
  });
  // zIndex driven purely by population — biggest wins overlap, no
  // capital-vs-non-capital tie-breaker. Selected bonus 10 000 is
  // unreachable by any natural pop, so the selection always wins (it's also on
  // its own no-declutter layer for belt-and-braces).
  const popZ = Math.floor(Math.log10(Math.max(population || 1, 1)) * 100);
  const selectedBoost = isSelected ? 10000 : 0;
  const zIndex = popZ + selectedBoost;
  return [new Style({ zIndex, text })];
}

// City results render at full opacity as soon as the post-move viewport
// query lands; there is no second alpha animation after the camera settles.
function featuresLayerStyle(feature) {
  return feature.getStyle();
}

// Only cities inside a buffered viewport are materialized as OpenLayers
// features. The worker still applies the global population tier, preserving
// the same label priority, but zooming no longer competes with an up-front
// build of 150 k cities × three wrapped copies.
const CITY_RENDER_BUFFER_PX = 160;
const CITY_QUERY_BUFFER_PX = 240;
const citySource = new VectorSource({ wrapX: false });
const cityLayer = new VectorLayer({
  renderBuffer: CITY_RENDER_BUFFER_PX,
  declutter: "cities",
  source: citySource,
  style: featuresLayerStyle,
});
map.addLayer(cityLayer);

// "Always" layer: super-capitals (capital AND pop ≥ 1 M) + selected
// (searched) cities. declutter:false so every feature in this layer
// renders unconditionally — that's how we honour "super capitals always
// appear" and "the searched city is always displayed" as hard rules.
const alwaysSource = new VectorSource({ wrapX: false });
const alwaysLayer = new VectorLayer({
  renderBuffer: CITY_RENDER_BUFFER_PX,
  declutter: false,
  source: alwaysSource,
  style: featuresLayerStyle,
  zIndex: 200,
});
map.addLayer(alwaysLayer);

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

// Canonical list of cities the worker selected for the buffered viewport.
// The actual features are three wrapped copies around the current world.
let canonicalCities = [];

// The current search selection stays bold and outside decluttering until a
// different city is selected. Keeping a single value ensures previous search
// targets immediately return to their regular style.
let selectedCity = null;
const cityKeyOf = (c) => `${c.x.toFixed(0)},${c.y.toFixed(0)}|${c.name}`;

function selectSearchedCity(city) {
  selectedCity = city;
  rebuildCityFeatures();
}

function rebuildCityFeatures() {
  const cx = view.getCenter()?.[0] ?? 0;
  const worldCenter = Math.round(cx / MERCATOR_WORLD);
  citySource.clear();
  alwaysSource.clear();

  // Merge the viewport result with the current search selection and render each
  // city exactly once, on either the decluttered or always-visible layer.
  const displayed = new Map();
  for (const c of canonicalCities) displayed.set(cityKeyOf(c), c);
  const selectedKey = selectedCity ? cityKeyOf(selectedCity) : null;
  if (selectedCity) displayed.set(selectedKey, selectedCity);

  const cityFeatures = [];
  const alwaysFeatures = [];
  for (const [key, city] of displayed) {
    const isSelected = key === selectedKey;
    const isSuper = city.super === 1;
    const target = isSelected || isSuper ? alwaysFeatures : cityFeatures;
    const sharedStyle = makeCityStyles(city.name, isSelected, city.population);
    const meta = { population: city.population, wiki: city.wiki };
    for (let w = worldCenter - 1; w <= worldCenter + 1; w++) {
      const feature = new Feature({
        geometry: new Point([city.x + w * MERCATOR_WORLD, city.y]),
        name: city.name,
        featureClass: "city",
        _dataset: "city",
        _label: city.name,
        _meta: meta,
      });
      feature.setStyle(sharedStyle);
      target.push(feature);
    }
  }
  if (cityFeatures.length) citySource.addFeatures(cityFeatures);
  if (alwaysFeatures.length) alwaysSource.addFeatures(alwaysFeatures);
}

citiesWorker.onmessage = (event) => {
  const msg = event.data;
  if (msg.type === "ready") {
    workerReady = true;
    onCitiesReady();
    refreshVisibleCities();
  } else if (msg.type === "result") {
    if (msg.id !== latestQueryId) return;
    canonicalCities = msg.cities;
    rebuildCityFeatures();
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
  const size = map.getSize();
  const resolution = view.getResolution();
  if (!size || !resolution) return;
  const extent = view.calculateExtent(size);
  const padding = CITY_QUERY_BUFFER_PX * resolution;
  const id = ++queryCounter;
  latestQueryId = id;
  citiesWorker.postMessage({
    type: "query",
    id,
    minX: extent[0] - padding,
    minY: Math.max(-MERCATOR_Y_MAX, extent[1] - padding),
    maxX: extent[2] + padding,
    maxY: Math.min(MERCATOR_Y_MAX, extent[3] + padding),
    limit: cityLimitFor(view.getZoom() ?? 0),
  });
}

map.on("moveend", () => {
  // Keep the current small feature set stable throughout the interaction;
  // query and swap the buffered viewport only after the camera settles.
  refreshVisibleCities();
});

/* ── generic point-dataset layers ─────────────────────────────────────── */

// Volcanoes / seamounts / megaliths / facts all share the same on-disk
// layout (see points-worker.js). Each gets its own Worker, VectorLayer, and
// style function — but the wire-up is identical, so it lives behind one
// factory. The factory returns nothing; it just registers the dataset with
// the global moveend dispatcher.

const pointDatasets = []; // { name, ready, worker, queryId, latestQueryId, source, makeStyle, limit, key }

function registerPointDataset({ name, url, makeStyle, limit = 250, hoverable = true }) {
  // wrapX=false + manual three-world-copy replication: same pattern as
  // the cities layer, for the same reason. Pan within a world leaves the
  // declutter input untouched; world-boundary crossings happen off-screen.
  // renderBuffer bumped to 400 so icons near the viewport edge stay drawn
  // while the user pans toward them — no pop-in.
  const source = new VectorSource({ wrapX: false });
  const layer = new VectorLayer({
    renderBuffer: 400,
    declutter: true,
    source,
    style: (feature) => feature.get("_style"),
  });
  map.addLayer(layer);
  // Register the layer as a hover-tooltip source so the pointermove handler
  // can identify-and-look-up just our point overlays (and not the city or
  // background layers, which already own their own interaction surfaces).
  if (hoverable) hoverTipLayers.push(layer);

  const ds = {
    name,
    ready: false,
    worker: new Worker(new URL("./points-worker.js", import.meta.url), { type: "module" }),
    queryId: 0,
    latestQueryId: 0,
    source,
    makeStyle,
    limit,
    // Canonical list of items the worker selected for the current zoom.
    // Features in `source` are derived from this — three copies of each
    // item at world centre ±1.
    canonicalItems: [],
    worldCenter: null,
    lastQueryZoomFloor: -1,
  };

  ds.worker.onmessage = (e) => {
    const m = e.data;
    if (m.type === "ready") {
      ds.ready = true;
      refreshDataset(ds);
    } else if (m.type === "result") {
      if (m.id !== ds.latestQueryId) return;
      ds.canonicalItems = m.items;
      ds.worldCenter = null; // force rebuild
      rebuildPointDatasetFeatures(ds);
    }
  };

  pointDatasets.push(ds);

  // Fetch the bin and hand it to the worker (zero-copy transfer).
  fetch(url)
    .then(async (res) => {
      if (!res.ok) throw new Error(`${name} → HTTP ${res.status}`);
      const buf = await res.arrayBuffer();
      ds.worker.postMessage({ type: "init", buffer: buf }, [buf]);
    })
    .catch((err) => console.warn(`failed to load ${name}:`, err.message));

  return ds;
}

function rebuildPointDatasetFeatures(ds) {
  const cx = view.getCenter()?.[0] ?? 0;
  const newWorldCenter = Math.round(cx / MERCATOR_WORLD);
  if (newWorldCenter === ds.worldCenter && ds.source.getFeatures().length > 0) {
    return;
  }
  ds.worldCenter = newWorldCenter;
  ds.source.clear();
  const zoom = view.getZoom() ?? 0;
  const features = [];
  let rank = 0;
  for (const p of ds.canonicalItems) {
    const thisRank = rank++;
    const style = ds.makeStyle(p, thisRank, zoom);
    for (let w = newWorldCenter - 1; w <= newWorldCenter + 1; w++) {
      const offsetX = w * MERCATOR_WORLD;
      const feat = new Feature({
        geometry: new Point([p.x + offsetX, p.y]),
        _label: p.label,
        _score: p.score,
        _meta: p.meta,
        _dataset: ds.name,
      });
      feat.set("_style", style);
      features.push(feat);
    }
  }
  if (features.length) ds.source.addFeatures(features);
}

function refreshDataset(ds) {
  if (!ds.ready) return;
  const zoom = view.getZoom() ?? 0;
  // No bbox — the worker returns the score-sorted top-N globally for the
  // current zoom floor. Pan never triggers this; only crossing a zoom-
  // floor boundary does. That guarantees the same set of points at every
  // pan position within a zoom level (the hard rule from product).
  const id = ++ds.queryId;
  ds.latestQueryId = id;
  ds.worker.postMessage({
    type: "query",
    id,
    zoom,
    limit: ds.limit,
  });
  ds.lastQueryZoomFloor = Math.floor(zoom);
}

function refreshAllPointDatasets() {
  for (const ds of pointDatasets) refreshDataset(ds);
}

map.on("moveend", () => {
  const zoom = view.getZoom() ?? 0;
  const zoomFloor = Math.floor(zoom);
  const cx = view.getCenter()?.[0] ?? 0;
  const newWorldCenter = Math.round(cx / MERCATOR_WORLD);
  for (const ds of pointDatasets) {
    if (!ds.ready) continue;
    if (zoomFloor !== ds.lastQueryZoomFloor) {
      // Zoom-floor changed — new features may have become eligible (their
      // per-feature minZoom dropped below the new zoom). Requery; the
      // result handler rebuilds the source.
      refreshDataset(ds);
    } else if (newWorldCenter !== ds.worldCenter) {
      // Same set, just slide the three copies one world over.
      rebuildPointDatasetFeatures(ds);
    }
  }
});

/* ── hover tooltip (facts, volcanoes, seamounts, megaliths) ───────────── */

// One floating DOM element follows the cursor and shows whatever point
// feature it's hovering. Each point dataset stores its label / score /
// meta on the Feature itself (see registerPointDataset), so the handler
// just reads those fields — no lookup back into the worker, no parsing.

const hoverTipEl = document.getElementById("hover-tip");
const hoverTipLayers = []; // populated below as each dataset is registered

function formatTipForFeature(feature) {
  const ds = feature.get("_dataset");
  // First try the point-dataset path (volcanoes, seamounts, megaliths,
  // facts, boats, cities) — those store {_label, _meta, _dataset} on the
  // Feature. If we miss, fall through to the MVT-feature branch below
  // for peaks / seas / regions baked into background.pmtiles.
  const label = feature.get("_label") || "";
  const meta = feature.get("_meta") || {};
  if (ds === "facts") {
    const year = meta.y;
    const cat = meta.k || "";
    return { title: label, sub: [Number.isFinite(year) ? formatYear(year) : "", cat].filter(Boolean).join(" · ") };
  }
  if (ds === "volcanoes") {
    const bits = [];
    if (meta.type) bits.push(meta.type);
    if (Number.isFinite(meta.elev)) bits.push(`${meta.elev} m`);
    if (Number.isFinite(meta.last)) bits.push(`last erupted ${meta.last}`);
    return { title: label, sub: bits.join(" · ") };
  }
  if (ds === "megaliths") return { title: label, sub: meta.type || "megalith" };
  if (ds === "seamounts") return { title: label, sub: "seamount" };
  if (ds === "castles") return { title: label, sub: "castle" };
  if (ds === "caves") return { title: label, sub: "cave" };
  if (ds === "city") {
    const pop = meta.population;
    return {
      title: label,
      sub: Number.isFinite(pop) && pop > 0 ? `${pop.toLocaleString()} people` : "city",
    };
  }
  if (ds === "ocean") {
    const d = meta.depth || 0;
    // Bathy bands are lower-bound depths: bathy_4000 means ≥ 4000 m.
    return { title: label, sub: d ? `depth ≥ ${d.toLocaleString()} m` : "ocean" };
  }
  // MVT path — feature came from a vector-tile layer, identity lives on
  // the original property bag (`featureClass`, `name`, `elevation`,
  // `featurecla`). The MVT layers don't carry _dataset.
  const cls = feature.get("featureClass");
  const name = feature.get("name");
  if (!name) return { title: "", sub: "" };
  if (cls === "peak") {
    const elev = feature.get("elevation");
    return { title: name, sub: Number.isFinite(elev) ? `summit · ${elev} m` : "summit" };
  }
  if (cls === "marine") {
    // featurecla distinguishes "ocean" / "sea" / "gulf" / "bay" /
    // "strait" / "channel" / "trench" / "trough" / "rise" / "reef" / …
    // We surface it directly so a hover over the Mariana Trench shows
    // "trench" instead of the generic "sea".
    const fc = (feature.get("featurecla") || "").toLowerCase();
    return { title: name, sub: fc || "sea / ocean" };
  }
  if (cls === "geo_region") {
    const fc = feature.get("featurecla");
    return { title: name, sub: fc || "region" };
  }
  return { title: name, sub: "" };
}

// Build the URL to open when the user clicks a feature. Wikidata-sourced
// items (we baked `qid` into meta during build) jump straight to their
// English Wikipedia article via `Special:GoToLinkedPage`. Everything else
// falls back to a Wikipedia search by name — works for cities, peaks,
// marine features, etc.
// Build the URL to open when the user clicks a feature. Three paths:
// boats → MarineTraffic live tracking; cities → Wikipedia search with the
// pre-built "City, [State,] Country" string; everything else → Wikipedia
// search by the feature's display name. Wikipedia's `go=Go` parameter
// auto-redirects to the exact-match article when one exists, so a
// well-known name like "Newgrange" or "Battle of Hastings" lands you on
// the article in one hop; ambiguous names land on a disambig page (still
// useful). The old QID-based Special:GoToLinkedPage path was dropped:
// items without an English Wikipedia sitelink (most long-tail megaliths)
// landed users on a Wikidata stub, which felt broken.
function wikipediaUrlForFeature(feature) {
  const meta = feature.get("_meta") || {};
  // Cities ship a pre-built search string ("Paris, Texas, United States"
  // for US, "Paris, France" elsewhere) so disambiguation works without
  // any runtime lookup.
  if (meta.wiki) {
    return `https://en.wikipedia.org/wiki/Special:Search?search=${encodeURIComponent(meta.wiki)}&go=Go`;
  }
  const tip = formatTipForFeature(feature);
  if (!tip.title) return null;
  // Strip leading emoji/category prefix from fact labels before searching.
  const cleaned = tip.title.replace(/^[\p{Extended_Pictographic}\p{Symbol}]\s*/u, "").trim();
  if (!cleaned) return null;
  return `https://en.wikipedia.org/wiki/Special:Search?search=${encodeURIComponent(cleaned)}&go=Go`;
}

function showHoverTip(pixel, feature) {
  const { title, sub } = formatTipForFeature(feature);
  if (!title) return hideHoverTip();
  hoverTipEl.innerHTML =
    `<div class="tip-title">${escapeHtml(title)}</div>` +
    (sub ? `<div class="tip-sub">${escapeHtml(sub)}</div>` : "");
  // Position above-right of the cursor, but flip horizontally near the
  // right edge so the tip doesn't get clipped.
  const w = hoverTipEl.offsetWidth || 200;
  const flipX = pixel[0] + w + 24 > window.innerWidth;
  const x = flipX ? pixel[0] - w - 14 : pixel[0] + 14;
  const y = pixel[1] - 28;
  hoverTipEl.style.left = `${Math.max(4, x)}px`;
  hoverTipEl.style.top = `${Math.max(4, y)}px`;
  hoverTipEl.classList.add("visible");
}

function hideHoverTip() {
  hoverTipEl.classList.remove("visible");
}

// What counts as "hover-able" — any feature with _label, or any MVT
// feature with one of the named-identity featureClasses. This is the same
// predicate used by both the hover and click handlers.
function featureIsInteractive(feature) {
  if (!feature) return false;
  if (feature.get("_label")) return true;
  const cls = feature.get("featureClass");
  if ((cls === "peak" || cls === "marine" || cls === "geo_region") && feature.get("name")) return true;
  return false;
}

// Synthetic "feature" we generate on the fly to surface ocean depth when
// the cursor is over water but not over any named marine entity. It looks
// like a normal interactive feature to formatTipForFeature.
function makeDepthFeature(deepestMeters) {
  const f = new Feature();
  f.set("_dataset", "ocean");
  f.set("_label", "Open ocean");
  f.set("_meta", { depth: deepestMeters });
  return f;
}

// Pointermove fires at ~60 Hz during a drag. forEachFeatureAtPixel walks
// every feature at the cursor (including bathymetry bands) which gets
// expensive at low zoom where the bathy stack is full. rAF-coalesce so
// we run the hit-test at most once per frame — visually indistinguishable
// from the unthrottled version, perceptibly smoother on lower-end laptops.
let pendingHoverEvent = null;
let pendingHoverFrame = 0;
function runHoverHit() {
  pendingHoverFrame = 0;
  const e = pendingHoverEvent;
  pendingHoverEvent = null;
  if (!e) return;
  if (e.dragging) return hideHoverTip();
  let hit = null;
  let deepestBathy = 0;
  map.forEachFeatureAtPixel(e.pixel, (feature) => {
    if (!hit && featureIsInteractive(feature)) hit = feature;
    const cls = feature.get("featureClass");
    if (typeof cls === "string" && cls.startsWith("bathy_")) {
      const depth = Number(cls.split("_")[1]) || 0;
      if (depth > deepestBathy) deepestBathy = depth;
    }
    return false;
  }, { hitTolerance: 6 });
  const realHit = hit;
  if (!hit && deepestBathy > 0) hit = makeDepthFeature(deepestBathy);
  if (hit) {
    showHoverTip([e.originalEvent.clientX, e.originalEvent.clientY], hit);
    // Toggle a CSS class on the map element so the click-hand cursor
    // declared in index.html (.map-clickable) takes over while the cursor
    // is over a city / castle / volcano / etc. Using a class keeps the
    // cursor unified with the rest of the UI without setting an inline
    // url() string here.
    mapElement.classList.toggle("map-clickable", !!realHit);
  } else {
    hideHoverTip();
    mapElement.classList.remove("map-clickable");
  }
}
map.on("pointermove", (e) => {
  pendingHoverEvent = e;
  if (!pendingHoverFrame) pendingHoverFrame = requestAnimationFrame(runHoverHit);
});
mapElement.addEventListener("mouseleave", hideHoverTip);

// Click → Wikipedia. Same hit-test as hover; uses `singleclick` (not
// "click") so the handler doesn't fire at the end of every drag-pan.
map.on("singleclick", (e) => {
  let hit = null;
  map.forEachFeatureAtPixel(e.pixel, (feature) => {
    if (!featureIsInteractive(feature)) return undefined;
    hit = feature;
    return true;
  }, { hitTolerance: 6 });
  if (!hit) return;
  const url = wikipediaUrlForFeature(hit);
  if (!url) return;
  // noopener so the new tab can't navigate back into our page.
  window.open(url, "_blank", "noopener");
});

/* ── styles for the four point datasets ───────────────────────────────── */

// Volcano: a hand-drawn-looking mountain+plume Icon (period engraver's
// pictograph). Bigger glyph for taller cones — elevation scales the icon.
// No on-map label: identity is shown on hover via the global tooltip.
const volcanoIconCache = new Map();
function volcanoIconFor(scalePx) {
  // Snap to a small set of sizes to share Icon instances across features.
  const tier = Math.round(scalePx);
  let icon = volcanoIconCache.get(tier);
  if (icon) return icon;
  icon = new Icon({
    src: VOLCANO_SVG_URL,
    width: tier,
    height: tier,
    anchor: [0.5, 0.85], // base of the cone sits on the lat/lon point
    rotateWithView: false,
  });
  volcanoIconCache.set(tier, icon);
  return icon;
}
function volcanoStyle(item /*, rank, zoom */) {
  const elev = item.meta?.elev || 0;
  // 24 px at sea level → 44 px for an 8 km cone. The icon is the entity's
  // identity at world scale, so size has to read across the map; tiny is
  // unreadable, big is correct.
  const px = 24 + Math.min(20, elev / 400);
  return [new Style({
    zIndex: 920,
    image: volcanoIconFor(px),
    declutterMode: "obstacle",  // reserve space; nearby labels yield to it
  })];
}

// Seamount: a downward triangle (the engraver's shorthand for "underwater
// peak"). Bigger than before so it's actually readable; identity revealed
// by hover, navigation by click.
const seamountFill = new Fill({ color: "rgba(75,55,30,0.85)" });
const seamountStroke = new Stroke({ color: "rgba(245,222,184,0.7)", width: 0.8 });
const seamountImg = new RegularShape({
  points: 3, radius: 6, angle: Math.PI, // pointing down ▽
  fill: seamountFill,
  stroke: seamountStroke,
});
function seamountStyle(/* item, rank, zoom */) {
  return [new Style({ zIndex: 50, image: seamountImg, declutterMode: "obstacle" })];
}

// Megalithic monuments — eight different period-engraving pictographs,
// dispatched on the `meta.type` baked at build time. Stone circles get a
// ring of upright stones; dolmens get the iconic Π capstone-on-uprights;
// menhirs get a single tapered standing stone; passage graves / tombs /
// tumuli get domed mounds; cairns get stacked rubble; the umbrella
// "megalith" type falls back to a generic standing stone. Each is a
// small data-URI SVG, cached as an Icon and reused across every feature
// of that type.
const MEGALITH_SVGS = {
  dolmen:
    "data:image/svg+xml;utf8," + encodeURIComponent(
      `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'>
         <g stroke='#2A1206' stroke-linecap='round' stroke-linejoin='round'>
           <rect x='3'  y='10' width='4' height='12' fill='#8C6233' stroke-width='1.2'/>
           <rect x='17' y='10' width='4' height='12' fill='#8C6233' stroke-width='1.2'/>
           <path d='M1 5 Q1 4 2 4 L22 4 Q23 4 23 5 L21 10 L3 10 Z' fill='#7a5a32' stroke-width='1.3'/>
           <line x1='5'  y1='14' x2='5'  y2='20' stroke-width='0.4'/>
           <line x1='19' y1='14' x2='19' y2='20' stroke-width='0.4'/>
           <line x1='6'  y1='7'  x2='8'  y2='7'  stroke-width='0.4'/>
           <line x1='12' y1='6.5' x2='14' y2='7'  stroke-width='0.4'/>
           <line x1='17' y1='7'  x2='19' y2='7'  stroke-width='0.4'/>
         </g>
       </svg>`,
    ),
  menhir:
    "data:image/svg+xml;utf8," + encodeURIComponent(
      `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'>
         <g stroke='#2A1206' stroke-linecap='round' stroke-linejoin='round'>
           <path d='M9 22 L7.5 4 Q9 2 12 2 Q15 2 16.5 4 L15 22 Z' fill='#8C6233' stroke-width='1.3'/>
           <line x1='10' y1='8'  x2='14' y2='8.5' stroke-width='0.4'/>
           <line x1='10' y1='13' x2='14' y2='13'  stroke-width='0.4'/>
           <line x1='10' y1='18' x2='14' y2='18'  stroke-width='0.4'/>
           <line x1='2'  y1='22' x2='22' y2='22' stroke-width='1.1'/>
         </g>
       </svg>`,
    ),
  "stone circle":
    "data:image/svg+xml;utf8," + encodeURIComponent(
      `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'>
         <g stroke='#2A1206' stroke-linecap='round' stroke-linejoin='round' fill='#8C6233'>
           <ellipse cx='4'  cy='14' rx='1.6' ry='2.6' stroke-width='1'/>
           <ellipse cx='8.5' cy='11' rx='1.6' ry='2.6' stroke-width='1'/>
           <ellipse cx='15.5' cy='11' rx='1.6' ry='2.6' stroke-width='1'/>
           <ellipse cx='20' cy='14' rx='1.6' ry='2.6' stroke-width='1'/>
           <ellipse cx='6'  cy='19' rx='1.6' ry='2.2' stroke-width='1'/>
           <ellipse cx='18' cy='19' rx='1.6' ry='2.2' stroke-width='1'/>
           <ellipse cx='12' cy='21' rx='1.6' ry='1.8' stroke-width='1'/>
         </g>
       </svg>`,
    ),
  "passage grave":
    "data:image/svg+xml;utf8," + encodeURIComponent(
      `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'>
         <g stroke='#2A1206' stroke-linecap='round' stroke-linejoin='round'>
           <path d='M2 22 Q2 8 12 6 Q22 8 22 22 Z' fill='#A07845' stroke-width='1.3'/>
           <path d='M9 22 L9 16 Q9 13 12 13 Q15 13 15 16 L15 22 Z' fill='#1d1206' stroke-width='1'/>
           <line x1='6'  y1='13' x2='7'  y2='15' stroke-width='0.4'/>
           <line x1='17' y1='13' x2='18' y2='15' stroke-width='0.4'/>
           <line x1='4'  y1='17' x2='5'  y2='19' stroke-width='0.4'/>
           <line x1='19' y1='17' x2='20' y2='19' stroke-width='0.4'/>
           <line x1='1'  y1='22' x2='23' y2='22' stroke-width='0.8'/>
         </g>
       </svg>`,
    ),
  "megalithic tomb":
    "data:image/svg+xml;utf8," + encodeURIComponent(
      `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'>
         <g stroke='#2A1206' stroke-linecap='round' stroke-linejoin='round'>
           <rect x='3'  y='12' width='3.5' height='10' fill='#8C6233' stroke-width='1.1'/>
           <rect x='10' y='12' width='3.5' height='10' fill='#8C6233' stroke-width='1.1'/>
           <rect x='17.5' y='12' width='3.5' height='10' fill='#8C6233' stroke-width='1.1'/>
           <path d='M1.5 8 Q1.5 7 2.5 7 L21.5 7 Q22.5 7 22.5 8 L21 12 L3 12 Z' fill='#7a5a32' stroke-width='1.3'/>
           <line x1='1' y1='22' x2='23' y2='22' stroke-width='0.8'/>
         </g>
       </svg>`,
    ),
  tumulus:
    "data:image/svg+xml;utf8," + encodeURIComponent(
      `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'>
         <g stroke='#2A1206' stroke-linecap='round' stroke-linejoin='round'>
           <path d='M1 22 Q1 7 12 5 Q23 7 23 22 Z' fill='#A07845' stroke-width='1.3'/>
           <path d='M3 18 Q3 11 12 9 Q21 11 21 18' fill='none' stroke='#7a5a32' stroke-width='0.6'/>
           <line x1='6'  y1='12' x2='7'  y2='14' stroke-width='0.4'/>
           <line x1='17' y1='12' x2='18' y2='14' stroke-width='0.4'/>
           <line x1='4'  y1='17' x2='5'  y2='19' stroke-width='0.4'/>
           <line x1='19' y1='17' x2='20' y2='19' stroke-width='0.4'/>
           <line x1='1'  y1='22' x2='23' y2='22' stroke-width='0.8'/>
         </g>
       </svg>`,
    ),
  cairn:
    "data:image/svg+xml;utf8," + encodeURIComponent(
      `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'>
         <g stroke='#2A1206' stroke-linecap='round' stroke-linejoin='round' fill='#8C6233'>
           <ellipse cx='6'  cy='20' rx='3'   ry='1.5' stroke-width='0.9'/>
           <ellipse cx='12' cy='20' rx='3.5' ry='1.6' stroke-width='0.9'/>
           <ellipse cx='18' cy='20' rx='3'   ry='1.5' stroke-width='0.9'/>
           <ellipse cx='8.5' cy='16' rx='3'   ry='1.6' stroke-width='0.9'/>
           <ellipse cx='15.5' cy='16' rx='3'   ry='1.6' stroke-width='0.9'/>
           <ellipse cx='11' cy='12' rx='3'   ry='1.7' stroke-width='1'/>
           <ellipse cx='12' cy='8'  rx='2.5' ry='1.5' stroke-width='1'/>
           <line x1='2' y1='22' x2='22' y2='22' stroke-width='0.6'/>
         </g>
       </svg>`,
    ),
  megalith:
    "data:image/svg+xml;utf8," + encodeURIComponent(
      `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'>
         <g stroke='#2A1206' stroke-linecap='round' stroke-linejoin='round'>
           <path d='M8 22 L6 6 Q8 3 12 3 Q16 3 18 6 L16 22 Z' fill='#8C6233' stroke-width='1.3'/>
           <line x1='9'  y1='9'  x2='15' y2='9.5' stroke-width='0.4'/>
           <line x1='9'  y1='15' x2='15' y2='15'  stroke-width='0.4'/>
           <line x1='2'  y1='22' x2='22' y2='22'  stroke-width='1'/>
         </g>
       </svg>`,
    ),
};
const megalithIconCache = new Map();
function megalithIconFor(type) {
  let icon = megalithIconCache.get(type);
  if (icon) return icon;
  const src = MEGALITH_SVGS[type] || MEGALITH_SVGS.megalith;
  icon = new Icon({
    src,
    width: 22,
    height: 22,
    anchor: [0.5, 0.95], // base of the monument sits on the lat/lon point
    rotateWithView: false,
  });
  megalithIconCache.set(type, icon);
  return icon;
}
function megalithStyle(item /*, rank, zoom */) {
  const type = (item.meta && item.meta.type) || "megalith";
  return [new Style({
    zIndex: 900,
    image: megalithIconFor(type),
    declutterMode: "obstacle",
  })];
}

// Castle: a small fortified-keep pictograph. Same icon-tier caching as the
// volcano — one Icon instance per pixel size, shared across features.
const castleIconCache = new Map();
function castleIconFor(scalePx) {
  const tier = Math.round(scalePx);
  let icon = castleIconCache.get(tier);
  if (icon) return icon;
  icon = new Icon({
    src: CASTLE_SVG_URL,
    width: tier,
    height: tier,
    anchor: [0.5, 0.85], // base of the keep sits on the lat/lon point
    rotateWithView: false,
  });
  castleIconCache.set(tier, icon);
  return icon;
}
function castleStyle(/* item, rank, zoom */) {
  return [new Style({
    zIndex: 910,
    image: castleIconFor(26),
    declutterMode: "obstacle",
  })];
}

// Cave: a small archway pictograph. Cached the same way.
const caveIconCache = new Map();
function caveIconFor(scalePx) {
  const tier = Math.round(scalePx);
  let icon = caveIconCache.get(tier);
  if (icon) return icon;
  icon = new Icon({
    src: CAVE_SVG_URL,
    width: tier,
    height: tier,
    anchor: [0.5, 0.85],
    rotateWithView: false,
  });
  caveIconCache.set(tier, icon);
  return icon;
}
function caveStyle(/* item, rank, zoom */) {
  return [new Style({
    zIndex: 915,
    image: caveIconFor(24),
    declutterMode: "obstacle",
  })];
}

// Historical fact: emoji glyph at a readable size. No on-map title —
// hover tip carries the year + title + category, click jumps to the
// Wikipedia article (see installPointClickHandler below).
function factStyle(item) {
  const cp = item.label.codePointAt(0);
  const glyph = cp ? String.fromCodePoint(cp) : "✶";
  return [new Style({
    zIndex: 1200,
    text: new Text({
      text: glyph,
      // 20 px is the sweet spot between scannable and crowding — a fact
      // glyph is a dot of meaning, not a poster.
      font: '20px serif',
      textAlign: "center",
      textBaseline: "middle",
      fill: new Fill({ color: COLOR_INK }),
      stroke: new Stroke({ color: COLOR_LAND, width: 3 }),
    }),
  })];
}

function formatYear(y) {
  if (!Number.isFinite(y)) return "";
  if (y < 0) return `${-y} BCE`;
  if (y < 1000) return `${y} CE`;
  return String(y);
}

// Limits are intentionally tight — there's a finite amount of space and a
// finite amount of attention. Better to show fewer, bigger, more legible
// icons than a confetti of unreadable dots.
registerPointDataset({ name: "volcanoes", url: VOLCANOES_URL, makeStyle: volcanoStyle, limit: 60 });
registerPointDataset({ name: "seamounts", url: SEAMOUNTS_URL, makeStyle: seamountStyle, limit: 50 });
registerPointDataset({ name: "megaliths", url: MEGALITHS_URL, makeStyle: megalithStyle, limit: 80 });
registerPointDataset({ name: "facts",     url: FACTS_URL,     makeStyle: factStyle,     limit: 80 });
registerPointDataset({ name: "castles",   url: CASTLES_URL,   makeStyle: castleStyle,   limit: 80 });
registerPointDataset({ name: "caves",     url: CAVES_URL,     makeStyle: caveStyle,     limit: 50 });

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
    // After the overlay finishes fading, try the GPS fly-to if the user
    // hasn't pinned a specific lat/lon via the URL hash. The geolocation
    // request was kicked off early (during load) so by the time the map
    // is ready, the permission prompt has usually already been answered.
    setTimeout(maybeFlyToGeolocation, 850);
  });
}

// Geolocation: requested at startup (in parallel with data loading) so
// the browser permission prompt is up while the user is staring at the
// loading title. If granted we save the coords and fly there as soon as
// the loading overlay finishes; if denied or unavailable we stay at the
// world view. Skipped entirely if the URL hash carries explicit coords
// (the user has asked for a specific view; don't second-guess them).
let pendingGeolocationTarget = null;
let automaticGeolocationEnabled = true;

function cancelAutomaticGeolocation() {
  automaticGeolocationEnabled = false;
  pendingGeolocationTarget = null;
}

function maybeFlyToGeolocation() {
  if (!automaticGeolocationEnabled) {
    pendingGeolocationTarget = null;
    return;
  }
  if (!pendingGeolocationTarget) return;
  const target = pendingGeolocationTarget;
  pendingGeolocationTarget = null;
  // simultaneous: pan + zoom interpolate together over the full duration
  // (no two-phase zoom-out-then-in). Reads as a smooth glide from the
  // world view toward the user's location.
  flyTo(
    fromLonLat([target.lon, target.lat]),
    target.zoom,
    { simultaneous: true, minDuration: 2500 },
  );
}
function startGeolocation() {
  if (initialHash) return; // user provided explicit coords
  if (!navigator.geolocation) return; // no API (rare)
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      // The permission callback may arrive several seconds after startup.
      // Never let it override a city selection or manual map interaction
      // that happened while the browser prompt was open.
      if (!automaticGeolocationEnabled) return;
      pendingGeolocationTarget = {
        lon: pos.coords.longitude,
        lat: pos.coords.latitude,
        // z=15 shows ~5 km of viewport — your city's name, surrounding
        // streets, nearby cities all visible. The original z=25 (the
        // archive's ceiling) shows ~10 m, which is past the PMTiles
        // native resolution (z=10), so it landed on blurry upscaled
        // tiles with no city label in viewport. z=15 is the sweet spot
        // for "open the map on me" — close enough to read your block,
        // wide enough that the city label and nearby data are visible.
        zoom: 15,
      };
      // If loading finished before the permission was granted, fly now.
      if (loadingEl.classList.contains("hidden")) {
        maybeFlyToGeolocation();
      }
    },
    () => { /* denied / timed out — stay at world view */ },
    {
      enableHighAccuracy: false,
      timeout: 8000,
      maximumAge: 60_000, // accept a recent cached fix
    },
  );
}
mapElement.addEventListener("pointerdown", cancelAutomaticGeolocation, { passive: true });
mapElement.addEventListener("wheel", cancelAutomaticGeolocation, { passive: true });
startGeolocation();

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

// Earth-style "fly to" — two parallel animations: the centre pans smoothly
// across the entire duration, while the zoom DIPS OUT then climbs back IN
// to the destination zoom. The dip is computed so the journey fits inside
// the viewport at the lowest point — for a Paris → Tokyo hop the camera
// pulls all the way out to world view first, sweeps across, and zooms back
// in; for Paris → Brussels the dip is barely perceptible. Pattern adapted
// from OpenLayers' flyTo example.
//
// Used by the search palette jumpTo() and by the initial GPS fly-to. The
// optional `duration` lets explicit UI navigation stay snappy, while
// `minDuration` lets the GPS path breathe across a large zoom change.
function flyTo(targetCenter, targetZoom, options = {}) {
  const currentCenter = view.getCenter();
  const currentZoom = view.getZoom() ?? 2;
  if (!currentCenter) {
    view.animate({ center: targetCenter, zoom: targetZoom, duration: 0 });
    return;
  }

  const dx = targetCenter[0] - currentCenter[0];
  const dy = targetCenter[1] - currentCenter[1];
  const size = map.getSize() || [window.innerWidth, window.innerHeight];

  // Simultaneous mode: a single OL animation that pans and zooms together
  // over the full duration. Used by the GPS fly-to so the camera glides
  // toward the user's location while gradually zooming in — no zoom-out
  // dip, no pan-then-zoom two-phase feel. Duration scales with the journey
  // unless the caller supplies an explicit UI-animation duration.
  if (options.simultaneous) {
    const distance = Math.sqrt(dx * dx + dy * dy);
    const zoomSpan = Math.abs(targetZoom - currentZoom);
    const baseDuration = Math.max(
      1100 + distance / 1.5e7 * 1000,
      1000 + zoomSpan * 100,
    );
    const minDuration = options.minDuration ?? 0;
    const duration = options.duration ?? Math.min(
      4000,
      Math.max(minDuration, 1100, baseDuration),
    );
    view.animate({ center: targetCenter, zoom: targetZoom, duration });
    return;
  }

  // Resolution that would fit the horizontal + vertical leg of the journey
  // into 70% of the viewport (the other 30% is padding so the start and
  // destination aren't sitting on the screen edge mid-flight).
  const fitRes = Math.max(
    Math.abs(dx) / (size[0] * 0.7),
    Math.abs(dy) / (size[1] * 0.7),
    1e-6,
  );
  const fitZoom = view.getZoomForResolution(fitRes);
  // Mid zoom: where the camera dips to mid-flight. The `forceMidZoom`
  // option lets callers (the search palette) demand the full zoom-out:
  // forceMidZoom=0 means "dip ALL the way to world view, then climb back
  // in", which gives the search a deliberate "out and in" feel even when
  // the start and destination are at similar zooms. Without it we just
  // dip as far as the journey needs to fit in viewport.
  const computedMidZoom = Math.max(0, Math.min(currentZoom, targetZoom, fitZoom));
  const midZoom = options.forceMidZoom !== undefined
    ? Math.max(view.getMinZoom?.() ?? 0, options.forceMidZoom)
    : computedMidZoom;

  // Duration scales with how far we have to fly AND how many zoom levels
  // the camera has to traverse. A short same-zoom hop is ~1.1 s; a
  // continent-crossing is ~2.4 s; a full out-and-in search flight is
  // ~3 s so the camera has time to breathe across the zoom levels.
  const distance = Math.sqrt(dx * dx + dy * dy);
  const zoomSpan = Math.abs(currentZoom - midZoom) + Math.abs(targetZoom - midZoom);
  const baseDuration = Math.max(
    1100 + distance / 1.5e7 * 1000,
    1000 + zoomSpan * 100,
  );
  const minDuration = options.minDuration ?? 0;
  const duration = Math.min(4000, Math.max(minDuration, 1100, baseDuration));

  // Short hop with no forced dip: a direct animation reads as a single
  // smooth motion. Skip the dip — it would look like a hiccup. When the
  // caller forces a midZoom we always do the parallel flight.
  const sameTier = Math.abs(midZoom - currentZoom) < 0.5;
  if (sameTier && distance < 1e6 && options.forceMidZoom === undefined) {
    view.animate({ center: targetCenter, zoom: targetZoom, duration });
    return;
  }

  // Parallel: centre interpolates over the full duration; zoom dips out
  // over the first half then climbs in to target over the second half.
  view.animate({ center: targetCenter, duration });
  view.animate(
    { zoom: midZoom, duration: duration / 2 },
    { zoom: targetZoom, duration: duration / 2 },
  );
}

function jumpTo(city) {
  cancelAutomaticGeolocation();
  closeSearch();
  selectSearchedCity(city);
  view.cancelAnimations();
  flyTo([city.x, city.y], zoomForCityPopulation(city.population), {
    simultaneous: true,
    duration: CITY_NAVIGATION_DURATION_MS,
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

// Corner search button — gives first-time visitors a visible affordance
// for the ⌘K shortcut. (GitHub button is a plain anchor; the browser
// handles target=_blank on its own.)
const btnSearchEl = document.getElementById("btn-search");
if (btnSearchEl) {
  btnSearchEl.addEventListener("click", () => {
    if (searchOpen) closeSearch();
    else openSearch();
  });
}

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
    {
      hitTolerance: 4,
      // Hit-test any city — regular labels and persistent search pins.
      layerFilter: (layer) => layer === cityLayer || layer === alwaysLayer,
    },
  );
}
