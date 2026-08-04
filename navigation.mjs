// Large cities need more surrounding context, while towns can land closer.
// This logarithmic scale maps 10 M+ people to z22, 1 M to z23, 100 k to z24,
// 10 k to z25, and 1 k or fewer to z26.
export function zoomForCityPopulation(population) {
  const safePopulation = Number.isFinite(population) && population > 0
    ? population
    : 100_000;
  const clampedPopulation = Math.max(1_000, Math.min(10_000_000, safePopulation));
  const zoom = 22 + (7 - Math.log10(clampedPopulation));
  return Math.max(22, Math.min(26, Math.round(zoom)));
}

export const CITY_NAVIGATION_DURATION_MS = 800;
