export const PROBE_PREFIX = '/api/probes';

export const API_PATHS = {
  health: '/api/health',
  egress: `${PROBE_PREFIX}/egress`,
  status: `${PROBE_PREFIX}/status`,
  durableObject: `${PROBE_PREFIX}/do`,
  socket: `${PROBE_PREFIX}/socket`,
  signature: `${PROBE_PREFIX}/signature`,
  database: `${PROBE_PREFIX}/database`,
  authConfig: `${PROBE_PREFIX}/auth-config`,
} as const;

export type ApiPath = (typeof API_PATHS)[keyof typeof API_PATHS];
