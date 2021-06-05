import VectorLayer from "ol/layer/Vector";
import VectorSource from "ol/source/Vector";
import { Fill, Style, RegularShape, Text, Stroke } from "ol/style";
import { GeoJSON } from "ol/format";
import { View, Map } from "ol";
import { fromLonLat, toLonLat } from "ol/proj";
import musicURL from "url:./static/assets/alexander-nakarada-medieval-loop-one.mp3";

/* Constants */

const COLOR_INK = "#000000";
const COLOR_LAND = "#E0C9A6";
const COLOR_WATER = "#F0DEC2";

/* Audio */

const audio = new Audio(musicURL);
audio.loop = true;
audio.play();

/* Map */

const mapElement = document.getElementById("map");
const map = new Map({
  target: mapElement,
  controls: [],
  view: new View({
    center: fromLonLat([2.3522, 48.8566]),
    smoothResolutionConstraint: false,
    zoom: 6,
  }),
  layers: [],
});
const mapView = map.getView();
const mapBaseResolution = mapView.getResolution();

mapElement.style.backgroundColor = COLOR_WATER;

/* Land layout */

function getLandStyle() {
  const coeff = mapBaseResolution / mapView.getResolution();
  return [
    new Style({
      stroke: new Stroke({ color: COLOR_INK, width: coeff * 31 }),
    }),
    new Style({
      stroke: new Stroke({ color: COLOR_WATER, width: coeff * 30 }),
    }),
    new Style({
      stroke: new Stroke({ color: COLOR_INK, width: coeff * 21 }),
    }),
    new Style({
      stroke: new Stroke({ color: COLOR_WATER, width: coeff * 20 }),
    }),
    new Style({
      stroke: new Stroke({ color: COLOR_INK, width: coeff * 15 }),
    }),
    new Style({
      stroke: new Stroke({ color: COLOR_WATER, width: coeff * 14 }),
    }),
    new Style({
      stroke: new Stroke({ color: COLOR_INK, width: coeff * 9 }),
    }),
    new Style({
      stroke: new Stroke({ color: COLOR_WATER, width: coeff * 8 }),
    }),
    new Style({
      stroke: new Stroke({ color: COLOR_INK, width: coeff * 3 }),
    }),
    new Style({
      fill: new Fill({ color: COLOR_LAND }),
    }),
  ];
}

const landLayout = new VectorLayer({
  updateWhileInteracting: true,
  style: getLandStyle(),
  source: new VectorSource({
    format: new GeoJSON(),
    url: "http://localhost:9999/data/lands",
  }),
});

map.addLayer(landLayout);

/* River layout */

function getRiverStyle() {
  const coeff = mapBaseResolution / mapView.getResolution();
  return [
    new Style({ stroke: new Stroke({ color: COLOR_INK, width: coeff * 2 }) }),
    new Style({ stroke: new Stroke({ color: COLOR_WATER, width: coeff }) }),
    new Style({ stroke: new Stroke({ color: COLOR_INK, width: 1 }) }),
  ];
}

const riverLayout = new VectorLayer({
  updateWhileInteracting: true,
  style: getRiverStyle(),
  source: new VectorSource({
    format: new GeoJSON(),
    url: "http://localhost:9999/data/rivers",
  }),
});

map.addLayer(riverLayout);

/* Feature layout */

function getFeatureStyle() {
  const coeff = mapBaseResolution / mapView.getResolution();
  const style = new Style({
    image: new RegularShape({
      fill: new Fill({ color: COLOR_INK }),
      points: 4,
      radius: coeff * 6,
      angle: Math.PI / 4,
    }),
    text: new Text({
      font: `bold ${coeff * 14}px "Luminari"`,
      offsetX: coeff * 8,
      offsetY: coeff * 2,
      textAlign: "left",
      fill: new Fill({ color: COLOR_INK }),
      stroke: new Stroke({ width: 2, color: COLOR_LAND }),
    }),
  });
  return function (feature) {
    style.getText().setText(feature.get("name"));
    return style;
  };
}

const featureLayout = new VectorLayer({
  declutter: true,
  updateWhileInteracting: true,
  style: getFeatureStyle(),
  source: new VectorSource({
    format: new GeoJSON(),
    url(extent) {
      const min = toLonLat(extent.slice(0, 2));
      const max = toLonLat(extent.slice(2, 4));
      const bbox = encodeURIComponent([...min, ...max].join(","));
      return `http://localhost:9999/data/features?bbox=${bbox}`;
    },
    strategy(extent) {
      return [extent];
    },
  }),
});

map.addLayer(featureLayout);

/* Context menu */

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

/* Resolution change */

mapView.on("change:resolution", function () {
  landLayout.setStyle(getLandStyle());
  riverLayout.setStyle(getRiverStyle());
  featureLayout.setStyle(getFeatureStyle());
});
