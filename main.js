import VectorLayer from "ol/layer/Vector";
import VectorSource from "ol/source/Vector";
import { Circle, Fill, Stroke, Style } from "ol/style";
import { GeoJSON } from "ol/format";
import { View, Map } from "ol";

import citiesURL from "url:./data/cities.geojson";
import landURL from "url:./data/land.geojson";
import riversURL from "url:./data/rivers.geojson";

const vectorSource = new VectorSource({ format: new GeoJSON() });
const vectorLayer = new VectorLayer({ source: vectorSource });

const map = new Map({
  controls: [],
  target: document.getElementById("map"),
  layers: [vectorLayer],
  view: new View({
    center: [0, 0],
    zoom: 2,
  }),
});

map.on("click", async function (event) {
  const features = await vectorLayer.getFeatures(event.pixel);
  const property = features[0]?.getProperties();
  if (property?.kind === "city") {
    window.open(
      `https://duckduckgo.com/?q=${encodeURIComponent(
        `!ducky site:en.wikipedia.org ${property.nameascii}, ${property.sov0name}`
      )}`,
      "_blank"
    );
  }
});

// Populate the vector source
[
  {
    kind: "city",
    url: citiesURL,
    style: new Style({
      image: new Circle({
        radius: 5,
        fill: new Fill({ color: "#000000" }),
      }),
    }),
  },
  {
    kind: "land",
    url: landURL,
    style: new Style({
      fill: new Fill({ color: "#808000" }),
    }),
  },
  {
    kind: "river",
    url: riversURL,
    style: new Style({
      stroke: new Stroke({ color: "#000000", width: 1 }),
    }),
  },
].forEach(async ({ kind, url, style }) => {
  const res = await fetch(url);
  const json = await res.json();

  const features = vectorSource
    .getFormat()
    .readFeatures(json, { featureProjection: "EPSG:3857" });
  for (const feature of features) {
    feature.setProperties({ kind });
    feature.setStyle(style);
  }

  vectorSource.addFeatures(features);
});
