import VectorLayer from "ol/layer/Vector";
import VectorSource from "ol/source/Vector";
import { Fill, Style, Circle } from "ol/style";
import { GeoJSON } from "ol/format";
import { View, Map } from "ol";
import { fromLonLat, toLonLat } from "ol/proj";
import * as loadingstrategy from "ol/loadingstrategy";

const map = new Map({
  target: document.getElementById("map"),
  controls: [],
  view: new View({
    center: fromLonLat([2.3522, 48.8566]),
    smoothResolutionConstraint: false,
    zoom: 6,
  }),
  layers: [
    // Display all lands
    new VectorLayer({
      source: new VectorSource({
        format: new GeoJSON(),
        strategy: loadingstrategy.all,
        url: "http://localhost:9999/data/lands",
      }),
      style: new Style({
        fill: new Fill({ color: "#808000" }),
      }),
    }),
    // Display features in the current bounding box
    new VectorLayer({
      source: new VectorSource({
        format: new GeoJSON(),
        strategy: loadingstrategy.bbox,
        url(extent) {
          const bbox = encodeURIComponent(
            [
              ...toLonLat(extent.slice(0, 2)),
              ...toLonLat(extent.slice(2, 4)),
            ].join(",")
          );
          return `http://localhost:9999/data/features?bbox=${bbox}`;
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
});

const mapElement = document.getElementById("map");
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
