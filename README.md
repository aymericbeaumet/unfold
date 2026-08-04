# unfold [![CI](https://github.com/aymericbeaumet/unfold/actions/workflows/ci.yml/badge.svg)](https://github.com/aymericbeaumet/unfold/actions/workflows/ci.yml)

Unfold is a fully static, old-world map built with
[OpenLayers](https://openlayers.org/) and [PMTiles](https://pmtiles.io/). It
combines a parchment-style world basemap with searchable cities, physical
geography, landmarks, and historical events. There is no application backend:
the browser loads prebuilt map and binary data files shipped with the site.

Live site: [unfold.aymericbeaumet.com](https://unfold.aymericbeaumet.com)

## Features

- An engraved world basemap with land, lakes, rivers, roads, parks, glaciers,
  mountain regions, peaks, marine labels, and 11 bathymetry bands.
- Search over the GeoNames cities500 dataset, with country-aware display names
  and normalized matching for accents, punctuation, and compact queries such
  as `newyork`.
- Fast city navigation: an 800 ms camera move and a population-derived zoom
  between 22 and 26. Only the current search selection remains bold.
- Additional static datasets for volcanoes, seamounts, megaliths, historical
  events, caves, and castles.
- Hover details and reference links for interactive map features.
- Browser geolocation on first load. Any city selection, drag, or wheel input
  cancels pending automatic navigation so it cannot override the user.
- Shareable Google Maps-style hashes in the form `#@latitude,longitude,zoomz`.
- A wrapped horizontal world with hard vertical and zoom limits.

## Controls

- Drag to pan and use the mouse wheel or trackpad to zoom.
- Press `Cmd+K`, `Ctrl+K`, `Cmd+F`, or `Ctrl+F` to search for a city. The
  search button in the top-right opens the same palette.
- Use the arrow keys and Enter to choose a search result; Escape closes the
  palette.
- Hover a marker for details and click an interactive feature to open its
  reference page.
- Right-click the map to copy coordinates, open the location in Google Maps,
  or enter fullscreen.

## Architecture

Unfold has no runtime service or database. Its data path is:

1. `build-data.mjs` downloads and normalizes upstream geographic sources.
2. Tippecanoe compiles background geography into one vector-tile archive,
   `data/background.pmtiles`.
3. Cities and point datasets are packed into typed-array binary files under
   `data/`.
4. Parcel emits a static production site in `dist/`.
5. The browser fetches PMTiles ranges and transfers binary datasets to Web
   Workers for filtering and search.

The parchment overlays are hidden while the camera is moving, vector-tile
rendering uses cached tiles, and city features are created only for a buffered
viewport after `moveend`. This keeps camera animation independent from the
full city dataset.

## Project layout

```text
.github/workflows/ci.yml  Lint, test, and GitHub Pages deployment
build-data.mjs            Static data download and packing pipeline
cities-worker.js          Viewport filtering and city search worker
data/                     Committed PMTiles and packed binary datasets
index.html                Application shell and styles
main.js                   Map rendering, interactions, and UI
navigation.mjs            City animation duration and population zoom policy
points-worker.js          Shared worker for non-city point datasets
static/                   Fonts, favicon, and cursor assets
test/                     Node.js unit tests
license                   MIT license
```

## Local development

Requirements:

- Node.js 20 or newer
- npm
- Tippecanoe only when regenerating `data/background.pmtiles`

Install the locked dependencies and start the development server:

```sh
npm ci
npm run dev
```

The site is available at <http://localhost:9191>. All runtime assets are
committed, so local development does not require Tippecanoe or an external API.

## Commands

```sh
npm run dev         # start Parcel on http://localhost:9191
npm run lint        # syntax-check application and data-pipeline JavaScript
npm test            # run Node.js unit tests
npm run build       # create the production site in dist/
npm run build-data  # refresh every generated artifact under data/
```

To rebuild only the point and city datasets while keeping the existing PMTiles
archive:

```sh
SKIP=pmtiles npm run build-data
```

## Static data

The generated files are committed so CI and normal development never need to
download or regenerate geographic sources.

- `background.pmtiles` contains the Natural Earth vector layers. The browser
  requests byte ranges from this single archive instead of loading separate
  GeoJSON files or making one request per tile.
- `cities.bin` is derived from GeoNames cities500 after duplicate and
  section-of-city folding. Its 14-field header points to projected X/Y arrays,
  population values, and UTF-8 name, display, search, and Wikipedia strings
  with offset tables. A capital-count field marks the leading capital block.
- `volcanoes.bin`, `seamounts.bin`, `megaliths.bin`, `facts.bin`, `caves.bin`,
  and `castles.bin` share a 10-field point format containing projected
  coordinates, score, minimum zoom, and offset-indexed label and JSON metadata.

To regenerate the static data, install Tippecanoe and run the pipeline:

```sh
brew install tippecanoe          # macOS
# sudo apt-get install tippecanoe  # Debian/Ubuntu
npm run build-data
```

Downloads are cached in `.data-cache/`. Re-running the pipeline reuses that
cache, and the pipeline prints the resulting feature counts and artifact sizes.

## City search and navigation

`cities-worker.js` owns the transferred `cities.bin` buffer and builds a
population-sorted index once at startup. Search scans normalized byte strings
without decoding every city name. Viewport queries work as follows:

1. After camera movement ends, `main.js` sends the buffered viewport and the
   population cutoff for the current zoom.
2. The worker scans the eligible population-ranked prefix and returns only
   visible cities, plus visible capitals with at least one million residents.
3. The main thread replaces the small visible feature set and discards stale
   worker responses by query ID.

Selecting a result cancels pending geolocation, replaces the previous selected
city, and animates directly to the result. `navigation.mjs` maps population to
zoom logarithmically: 10M+ residents maps to 22, then each tenfold population
decrease adds one zoom level, capped at 26.

## CI and deployment

The [CI workflow](./.github/workflows/ci.yml) runs three jobs:

1. **Lint** installs locked dependencies and runs `npm run lint`.
2. **Test** runs the Node.js navigation tests with `npm test`.
3. **Deploy** waits for lint and test, builds the site, writes the production
   `CNAME`, and publishes `dist/` to GitHub Pages.

Pull requests run lint and test without deploying. Pushes to `main`, plus
manual workflow runs, may deploy after both checks pass. GitHub Pages must use
**GitHub Actions** as its deployment source.

## Data sources

- [Natural Earth](https://www.naturalearthdata.com/) — public domain
- [GeoNames cities500](https://www.geonames.org/) — CC BY 4.0
- [Smithsonian Global Volcanism Program](https://volcano.si.edu/) — CC BY 4.0
- [Wikidata](https://www.wikidata.org/) — CC0

## License

Unfold is available under the [MIT License](./license).
