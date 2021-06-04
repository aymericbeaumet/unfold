import VectorLayer from "ol/layer/Vector";
import ImageLayer from "ol/layer/Image";
import VectorSource from "ol/source/Vector";
import { Fill, Style, RegularShape, Text, Stroke } from "ol/style";
import { GeoJSON } from "ol/format";
import { View, Map } from "ol";
import { fromLonLat, toLonLat } from "ol/proj";
import musicURL from "url:./static/assets/alexander-nakarada-medieval-loop-one.mp3";

const audio = new Audio(musicURL);
audio.loop = true;
audio.play();

const DETAILS = "#000000";
const LAND = "#E0C9A6";
const SEA = "#F0DEC2";

const mapElement = document.getElementById("map");
mapElement.style.backgroundColor = SEA;

const landStyle = [
  new Style({ stroke: new Stroke({ color: DETAILS, width: 31 }) }),
  new Style({ stroke: new Stroke({ color: SEA, width: 30 }) }),
  new Style({ stroke: new Stroke({ color: DETAILS, width: 21 }) }),
  new Style({ stroke: new Stroke({ color: SEA, width: 20 }) }),
  new Style({ stroke: new Stroke({ color: DETAILS, width: 15 }) }),
  new Style({ stroke: new Stroke({ color: SEA, width: 14 }) }),
  new Style({ stroke: new Stroke({ color: DETAILS, width: 9 }) }),
  new Style({ stroke: new Stroke({ color: SEA, width: 8 }) }),
  new Style({ stroke: new Stroke({ color: DETAILS, width: 3 }) }),
  new Style({ fill: new Fill({ color: LAND }) }),
];

const riverStyle = new Style({
  stroke: new Stroke({ color: DETAILS, width: 2 }),
});

const featureStyle = new Style({
  image: new RegularShape({
    fill: new Fill({ color: DETAILS }),
    points: 4,
    radius: 6,
    angle: Math.PI / 4,
  }),
  text: new Text({
    font: 'bold 13px "Luminari"',
    offsetX: 8,
    offsetY: 2,
    textAlign: "left",
    fill: new Fill({ color: DETAILS }),
  }),
});

const map = new Map({
  target: document.getElementById("map"),
  controls: [],
  view: new View({
    center: fromLonLat([2.3522, 48.8566]),
    smoothResolutionConstraint: false,
    zoom: 6,
  }),
  layers: [
    // Display lands
    new VectorLayer({
      updateWhileInteracting: true,
      style: landStyle,
      source: new VectorSource({
        format: new GeoJSON(),
        url: "http://localhost:9999/data/lands",
      }),
    }),
    // Display rivers
    new VectorLayer({
      updateWhileInteracting: true,
      style: riverStyle,
      source: new VectorSource({
        format: new GeoJSON(),
        url: "http://localhost:9999/data/rivers",
      }),
    }),
    // Display features in the current bounding box
    new VectorLayer({
      declutter: true,
      updateWhileInteracting: true,
      style(feature) {
        featureStyle.getText().setText(feature.get("name"));
        return featureStyle;
      },
      source: new VectorSource({
        format: new GeoJSON(),
        url(extent) {
          const bbox = encodeURIComponent(
            [
              ...toLonLat(extent.slice(0, 2)),
              ...toLonLat(extent.slice(2, 4)),
            ].join(",")
          );
          return `http://localhost:9999/data/features?bbox=${bbox}`;
        },
        strategy(extent) {
          return [extent];
        },
      }),
    }),
  ],
});

const contextMenuElement = document.getElementById("context-menu");
const coordinatesElement = contextMenuElement.querySelector(
  '[data-action="coordinates"]'
);

map.on("contextmenu", function (event) {
  event.preventDefault();

  const [lon, lat] = toLonLat(event.coordinate);
  coordinatesElement.innerHTML = `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
  coordinatesElement.setAttribute("data-lat", lat);
  coordinatesElement.setAttribute("data-lon", lon);

  let x = event.originalEvent.clientX;
  const clientXDelta =
    x + contextMenuElement.offsetWidth - document.body.offsetWidth;
  if (clientXDelta > 0) {
    x -= clientXDelta;
  }

  let y = event.originalEvent.clientY;
  const clientYDelta =
    y + contextMenuElement.offsetHeight - document.body.offsetHeight;
  if (clientYDelta > 0) {
    y -= clientYDelta;
  }

  contextMenuElement.style.top = `${y}px`;
  contextMenuElement.style.left = `${x}px`;
  contextMenuElement.classList.add("visible");
});

document.body.addEventListener(
  "mousedown",
  function (event) {
    event.preventDefault();

    if (event.target.offsetParent === contextMenuElement) {
      const lat = coordinatesElement.getAttribute("data-lat");
      const lon = coordinatesElement.getAttribute("data-lon");
      switch (event.target.getAttribute("data-action")) {
        case "coordinates":
          navigator.clipboard.writeText([lat, lon].join(", "));
          break;
        case "fullscreen":
          mapElement.requestFullscreen();
          break;
        case "googlemaps":
          const latlon = encodeURIComponent([lat, lon].join(","));
          window.open(
            `https://www.google.com/maps?q=${latlon}&ll=${latlon}&z=8`,
            "_blank"
          );
          break;
        case "sourcecode":
          window.open("https://github.com/aymericbeaumet/retromap", "_blank");
          break;
      }
    }

    contextMenuElement.classList.remove("visible");
  },
  true
);
