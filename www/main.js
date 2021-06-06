import VectorLayer from "ol/layer/Vector";
import GraticuleLayer from "ol/layer/Graticule";
import VectorSource from "ol/source/Vector";
import { Fill, Style, RegularShape, Text, Stroke, Icon } from "ol/style";
import { GeoJSON } from "ol/format";
import { View, Map } from "ol";
import { fromLonLat, toLonLat } from "ol/proj";

import peakSVG from "url:./static/assets/mountains-mountain-svgrepo-com.svg";

/* Constants */

const COLOR_INK = "#000000";
const COLOR_LAND = "#E0C9A6";
const COLOR_WATER = "#F0DEC2";

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
const mapViewInitialResolution = mapView.getResolution();

mapElement.style.backgroundColor = COLOR_WATER;

/* Land layer */

function getLandStyle(scale = 1) {
  return [
    new Style({
      zIndex: 1,
      stroke: new Stroke({ color: COLOR_INK, width: scale * 31 }),
    }),
    new Style({
      zIndex: 2,
      stroke: new Stroke({ color: COLOR_WATER, width: scale * 30 }),
    }),
    new Style({
      zIndex: 3,
      stroke: new Stroke({ color: COLOR_INK, width: scale * 21 }),
    }),
    new Style({
      zIndex: 4,
      stroke: new Stroke({ color: COLOR_WATER, width: scale * 20 }),
    }),
    new Style({
      zIndex: 5,
      stroke: new Stroke({ color: COLOR_INK, width: scale * 15 }),
    }),
    new Style({
      zIndex: 6,
      stroke: new Stroke({ color: COLOR_WATER, width: scale * 14 }),
    }),
    new Style({
      zIndex: 7,
      stroke: new Stroke({ color: COLOR_INK, width: scale * 9 }),
    }),
    new Style({
      zIndex: 8,
      stroke: new Stroke({ color: COLOR_WATER, width: scale * 8 }),
    }),
    new Style({
      zIndex: 9,
      stroke: new Stroke({ color: COLOR_INK, width: scale * 3 }),
    }),
    new Style({
      zIndex: 10,
      fill: new Fill({ color: COLOR_LAND }),
    }),
  ];
}

const landLayer = new VectorLayer({
  updateWhileInteracting: true,
  style: getLandStyle(),
  source: new VectorSource({
    format: new GeoJSON(),
    url: "http://localhost:9999/data/lands",
  }),
});

map.addLayer(landLayer);

/* Peak layer */

console.log(peakSVG);

function getPeakStyle(scale = 1) {
  return new Style({ image: new Icon({ src: peakSVG, scale }) });
}

const peakLayer = new VectorLayer({
  updateWhileInteracting: true,
  style: getPeakStyle(),
  source: new VectorSource({
    format: new GeoJSON(),
    url: "http://localhost:9999/data/peaks",
  }),
});

map.addLayer(peakLayer);

/* River layer */

function getRiverStyle(scale = 1) {
  return [
    new Style({ stroke: new Stroke({ color: COLOR_INK, width: scale * 2 }) }),
    new Style({ stroke: new Stroke({ color: COLOR_WATER, width: scale }) }),
    new Style({ stroke: new Stroke({ color: COLOR_INK, width: 1 }) }),
  ];
}

const riverLayer = new VectorLayer({
  updateWhileInteracting: true,
  style: getRiverStyle(),
  source: new VectorSource({
    format: new GeoJSON(),
    url: "http://localhost:9999/data/rivers",
  }),
});

map.addLayer(riverLayer);

/* Feature layer */

function getFeatureStyle(scale = 1) {
  const style = new Style({
    image: new RegularShape({
      fill: new Fill({ color: COLOR_INK }),
      points: 4,
      radius: scale * 6,
      angle: Math.PI / 4,
    }),
    text: new Text({
      font: `bold ${scale * 14}px "Luminari"`,
      offsetX: scale * 8,
      offsetY: scale * 2,
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

const featureLayer = new VectorLayer({
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

map.addLayer(featureLayer);

/* Graticule layer */

const graticuleLayer = new GraticuleLayer({
  strokeStyle: new Stroke({
    color: COLOR_INK,
  }),
  intervals: [10],
  showLabels: true,
  lonLabelFormatter(lon) {
    return lon < 0 ? lon + 360 : lon;
  },
  latLabelFormatter(lat) {
    return Math.abs(lat);
  },
});

map.addLayer(graticuleLayer);

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
  const scale = mapViewInitialResolution / mapView.getResolution();
  featureLayer.setStyle(getFeatureStyle(scale));
  landLayer.setStyle(getLandStyle(scale));
  peakLayer.setStyle(getPeakStyle(scale));
  riverLayer.setStyle(getRiverStyle(scale));
});
