import VectorLayer from "ol/layer/Vector";
import VectorSource from "ol/source/Vector";
import { Fill, Style, Circle } from "ol/style";
import { GeoJSON } from "ol/format";
import { View, Map } from "ol";
import { transform } from "ol/proj";
import * as loadingstrategy from "ol/loadingstrategy";

const map = new Map({
  controls: [],
  target: document.getElementById("map"),
  layers: [
    // Display all lands
    new VectorLayer({
      source: new VectorSource({
        format: new GeoJSON(),
        strategy: loadingstrategy.all,
        url: "http://localhost:9090/data/lands",
      }),
      style: new Style({
        fill: new Fill({ color: "#808000" }),
      }),
    }),
    // Display cities in the current bounding box
    new VectorLayer({
      source: new VectorSource({
        format: new GeoJSON(),
        strategy: loadingstrategy.bbox,
        loader: async function (extent, resolution, projection) {
          const res = await fetch("http://localhost:9090/data/cities");
          const json = await res.json();
          const features = this.getFormat().readFeatures(json, {
            featureProjection: "EPSG:3857",
          });
          this.addFeatures(features);
        },
      }),
      style: new Style({
        image: new Circle({
          radius: 5,
          fill: new Fill({ color: "#000000" }),
        }),
      }),
    }),
  ],
  view: new View({
    center: transform([2.3522, 48.8566], "EPSG:4326", "EPSG:3857"),
    zoom: 6,
    smoothResolutionConstraint: false,
  }),
});

const mapElement = document.getElementById("map");
const contextMenuElement = document.getElementById("context-menu");
const coordinatesElement = contextMenuElement.querySelector(
  '[data-action="coordinates"]'
);

map.on("contextmenu", function (event) {
  event.preventDefault();

  const [lng, lat] = transform(event.coordinate, "EPSG:3857", "EPSG:4326");

  coordinatesElement.innerHTML = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
  coordinatesElement.setAttribute("data-latlng", `${lat}, ${lng}`);

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
      switch (event.target.getAttribute("data-action")) {
        case "coordinates":
          navigator.clipboard.writeText(
            coordinatesElement.getAttribute("data-latlng")
          );
          break;
        case "fullscreen":
          mapElement.requestFullscreen();
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
