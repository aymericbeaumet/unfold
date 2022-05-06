import VectorLayer from "ol/layer/Vector";
import VectorImageLayer from "ol/layer/VectorImage";
import GraticuleLayer from "ol/layer/Graticule";
import VectorSource from "ol/source/Vector";
import { Fill, Style, RegularShape, Text, Stroke } from "ol/style";
import { GeoJSON } from "ol/format";
import { View, Map } from "ol";
import { fromLonLat, toLonLat } from "ol/proj";

/* Constants */

const COLOR_GRATICULE = "#5E5E5E";
const COLOR_INK = "#000000";
const COLOR_LAND = "#E0C9A6";
const COLOR_WATER = "#F0DEC2";
const COLOR_WATER_SHALLOW = "#D6C6AB";
const COLOR_WATER_DEEP = "#BDAE97";

/* Map */

const mapElement = document.getElementById("map");
const map = new Map({
  target: mapElement,
  controls: [],
  view: new View({
    center: fromLonLat([2.3522, 48.8566]),
    zoom: 6,
  }),
});

mapElement.style.backgroundColor = COLOR_WATER;

/* Background layer */

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
    new Style({
      zIndex: 301,
      stroke: new Stroke({ color: COLOR_INK, width: 31 }),
    }),
    new Style({
      zIndex: 302,
      stroke: new Stroke({ color: COLOR_WATER, width: 30 }),
    }),
    new Style({
      zIndex: 303,
      stroke: new Stroke({ color: COLOR_INK, width: 21 }),
    }),
    new Style({
      zIndex: 304,
      stroke: new Stroke({ color: COLOR_WATER, width: 20 }),
    }),
    new Style({
      zIndex: 305,
      stroke: new Stroke({ color: COLOR_INK, width: 15 }),
    }),
    new Style({
      zIndex: 306,
      stroke: new Stroke({ color: COLOR_WATER, width: 14 }),
    }),
    new Style({
      zIndex: 307,
      stroke: new Stroke({ color: COLOR_INK, width: 9 }),
    }),
    new Style({
      zIndex: 308,
      stroke: new Stroke({ color: COLOR_WATER, width: 8 }),
    }),
    new Style({
      zIndex: 309,
      stroke: new Stroke({ color: COLOR_INK, width: 3 }),
    }),
    new Style({
      zIndex: 310,
      fill: new Fill({ color: COLOR_LAND }),
    }),
  ];

  const marine = new Style({
    zIndex: 400,
    text: new Text({
      fill: new Fill({ color: COLOR_INK }),
      font: 'bold 18px "Luminari"',
    }),
  });

  const glacier = new Style({
    zIndex: 500,
    fill: new Fill({ color: "darkgray" }),
  });

  const river = new Style({
    zIndex: 600,
    stroke: new Stroke({ color: COLOR_INK, width: 1 }),
  });

  const lake = new Style({
    zIndex: 700,
    fill: new Fill({ color: COLOR_WATER }),
    stroke: new Stroke({ color: COLOR_INK, width: 1 }),
  });

  return function (feature) {
    switch (feature.get("featureClass")) {
      case "bathymetry_deep":
        return bathymetry_deep;
      case "bathymetry_shallow":
        return bathymetry_shallow;
      case "glacier":
        return glacier;
      case "lake":
        return lake;
      case "land":
        return land;
      case "marine":
        marine.getText().setText(feature.get("name"));
        return marine;
      case "river":
        return river;
    }
  };
}

const backgroundLayer = new VectorImageLayer({
  declutter: true,
  imageRatio: 2,
  style: backgroundLayerStyle(),
  source: new VectorSource({
    format: new GeoJSON(),
    url: `${process.env.API_URL}/background`,
  }),
});

map.addLayer(backgroundLayer);

/* Features layer */

function featuresLayerStyle() {
  const style = new Style({
    zIndex: 100,
    image: new RegularShape({
      fill: new Fill({ color: COLOR_INK }),
      points: 4,
      radius: 6,
      angle: Math.PI / 4,
      stroke: new Stroke({ color: COLOR_LAND, width: 1 }),
    }),
    text: new Text({
      font: 'bold 14px "Luminari"',
      textAlign: "left",
      offsetX: 8,
      offsetY: 2,
      fill: new Fill({ color: COLOR_INK }),
      stroke: new Stroke({ color: COLOR_LAND, width: 2 }),
    }),
  });

  return function (feature) {
    style.getText().setText(feature.get("name"));
    return style;
  };
}

let _featuresResolution;
const featuresLayer = new VectorLayer({
  renderBuffer: 200,
  declutter: true,
  imageRatio: 2,
  style: featuresLayerStyle(),
  source: new VectorSource({
    format: new GeoJSON(),
    url(extent, resolution) {
      _featuresResolution = resolution;
      const min = toLonLat(extent.slice(0, 2));
      const max = toLonLat(extent.slice(2, 4));
      const bbox = encodeURIComponent([...min, ...max].join(","));
      return `${process.env.API_URL}/features?bbox=${bbox}`;
    },
    strategy(extent, resolution) {
      if (_featuresResolution) {
        if (_featuresResolution > resolution) {
          this.loadedExtentsRtree_.clear();
        } else if (_featuresResolution < resolution) {
          this.clear();
        }
      }
      return [extent];
    },
  }),
});

map.addLayer(featuresLayer);

/* Graticule layer */

const graticuleLayer = new GraticuleLayer({
  strokeStyle: new Stroke({ color: COLOR_GRATICULE }),
  maxZoom: 5,
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

map.on("dblclick", function (event) {
  event.preventDefault();
});

/* Move */

map.on("pointerdrag", function () {
  document.body.classList.add("cursor-move");
});

document.addEventListener("mouseup", function () {
  document.body.classList.remove("cursor-move");
});

/* Context menu */

const contextMenuElement = document.getElementById("context-menu");
const coordinatesElement = contextMenuElement.querySelector(
  '[data-action="coordinates"]'
);

map.on("contextmenu", function (event) {
  event.preventDefault();

  const feature = getFeatureAtPixel(event);
  const [lon, lat] = feature
    ? toLonLat(feature.getGeometry().getCoordinates())
    : toLonLat(event.coordinate);
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

document.body.addEventListener("mousedown", function (event) {
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
    }
  }

  contextMenuElement.classList.remove("visible");
});

/* Helpers */

function getFeatureAtPixel(event) {
  return map.forEachFeatureAtPixel(
    event.pixel,
    function (feature) {
      switch (feature.get("featureClass")) {
        case "city":
          return feature;
      }
    },
    { hitTolerance: 4 }
  );
}
