export const MATCH_PREFIX = '/api/matchmaking';
export const GAME_PREFIX = '/api/game';
export const PROBE_PREFIX = '/api/probes';

export const API_PATHS = {
  questions: '/api/questions/manage',
  health: '/api/health',
  organizationOverview: '/api/organization/overview',
  organizationProfile: '/api/organization/profile',
  accountWithdrawal: '/api/organization/withdrawal',
  withdrawalStatus: '/api/organization/withdrawal/status',
  moderationUsers: '/api/organization/users',
  moderationMutate: '/api/organization/users/mutate',
  moderationWorkflow: '/api/organization/users/workflow',
  moderationHistory: '/api/organization/users/history',
  moderationPersonal: '/api/organization/users/personal',
  organizationSetup: '/api/organization/setup',
  organizationAdd: '/api/organization/instances/add',
  organizationRename: '/api/organization/instances/rename',
  organizationPermissions: '/api/organization/permissions',
  organizationGrants: '/api/organization/instances/grants',
  organizationPublish: '/api/organization/instances/publish',
  organizationOperation: '/api/organization/instances/operation',
  instanceDeletion: '/api/organization/instances/delete',
  results: '/api/results/overview',
  publicAuthConfig: '/api/auth/config',
  logout: '/api/matchmaking/logout-all',
  matchConfig: `${MATCH_PREFIX}/config`,
  matchJoin: `${MATCH_PREFIX}/join`,
  matchResume: `${MATCH_PREFIX}/resume`,
  matchCancel: `${MATCH_PREFIX}/cancel`,
  matchLogout: `${MATCH_PREFIX}/logout`,
  matchSocket: `${MATCH_PREFIX}/socket`,
  gameJoin: `${GAME_PREFIX}/join`,
  gameSocket: `${GAME_PREFIX}/socket`,
  egress: `${PROBE_PREFIX}/egress`,
  status: `${PROBE_PREFIX}/status`,
  durableObject: `${PROBE_PREFIX}/do`,
  socket: `${PROBE_PREFIX}/socket`,
  signature: `${PROBE_PREFIX}/signature`,
  database: `${PROBE_PREFIX}/database`,
  authConfig: `${PROBE_PREFIX}/auth-config`,
} as const;

export type ApiPath = (typeof API_PATHS)[keyof typeof API_PATHS];

export function instanceApiPath(path: string, instanceId = '') {
  return instanceId ? `${path}?instance=${encodeURIComponent(instanceId)}` : path;
}
