import assert from "node:assert/strict";
import test from "node:test";

import {
  CITY_NAVIGATION_DURATION_MS,
  zoomForCityPopulation,
} from "../navigation.mjs";

test("city navigation uses a short animation", () => {
  assert.equal(CITY_NAVIGATION_DURATION_MS, 800);
});

test("city zoom scales logarithmically with population", () => {
  assert.equal(zoomForCityPopulation(10_000_000), 22);
  assert.equal(zoomForCityPopulation(1_000_000), 23);
  assert.equal(zoomForCityPopulation(100_000), 24);
  assert.equal(zoomForCityPopulation(10_000), 25);
  assert.equal(zoomForCityPopulation(1_000), 26);
});

test("city zoom stays between 22 and 26", () => {
  assert.equal(zoomForCityPopulation(50_000_000), 22);
  assert.equal(zoomForCityPopulation(500), 26);
  assert.equal(zoomForCityPopulation(undefined), 24);
});
