// Bound each invocation below the Free plan's external/internal request limits.
export const erasureBatch = {
  rooms: 25,
  jobs: 2,
  authentication: 10,
  results: 25,
  inventory: 100,
};
