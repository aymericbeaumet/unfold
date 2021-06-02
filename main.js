import VectorLayer from "ol/layer/Vector";
import VectorSource from "ol/source/Vector";
import { Circle, Fill, Stroke, Style } from "ol/style";
import { GeoJSON } from "ol/format";
import { View, Map } from "ol";

import citiesURL from "url:./data/cities.geojson";
import landURL from "url:./data/land.geojson";
import riversURL from "url:./data/rivers.geojson";

const vectorSource = new VectorSource({ format: new GeoJSON() });

new Map({
  target: document.getElementById("map"),
  layers: [new VectorLayer({ source: vectorSource })],
  view: new View({
    center: [0, 0],
    zoom: 2,
  }),
});

// Populate the vector source
[
  {
    url: citiesURL,
    style: new Style({
      image: new Circle({
        radius: 1,
        fill: new Fill({ color: "#000000" }),
        stroke: new Stroke({ color: "#000000", width: 1 }),
      }),
    }),
  },
  {
    url: landURL,
    style: new Style({
      fill: new Fill({ color: "#808000" }),
    }),
  },
  {
    url: riversURL,
    style: new Style({
      stroke: new Stroke({ color: "#000000", width: 1 }),
    }),
  },
].forEach(async ({ url, style }) => {
  const res = await fetch(url);
  const json = await res.json();

  const features = vectorSource
    .getFormat()
    .readFeatures(json, { featureProjection: "EPSG:3857" });
  for (const feature of features) {
    feature.setStyle(style);
  }

  vectorSource.addFeatures(features);
});
