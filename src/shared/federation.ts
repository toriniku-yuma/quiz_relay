// A one-minute refresh plus bounded scheduler/transport jitter. Failed reads
// invalidate immediately; this is only the maximum lifetime of a successful read.
export const FEDERATION_FRESH_MS = 90000;
export const federationCapabilities = [
  'ranked',
  'casual',
  'questions',
  'results',
] as const;
export type FederationCapability = (typeof federationCapabilities)[number];
export type FederationPermissions = {
  send: Record<FederationCapability, boolean>;
  receive: Record<FederationCapability, boolean>;
};
export function disabledFederationPermissions(): FederationPermissions {
  return {
    send: { ranked: false, casual: false, questions: false, results: false },
    receive: { ranked: false, casual: false, questions: false, results: false },
  };
}
export function federationPermissions(value: unknown): FederationPermissions {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('INVALID_PERMISSIONS');
  const permissions = value as FederationPermissions;
  if (Object.keys(permissions).sort().join(',') !== 'receive,send')
    throw new Error('INVALID_PERMISSIONS');
  for (const direction of ['send', 'receive'] as const) {
    const row = permissions[direction];
    if (
      !row ||
      typeof row !== 'object' ||
      Array.isArray(row) ||
      Object.keys(row).sort().join(',') !==
        [...federationCapabilities].sort().join(',') ||
      federationCapabilities.some((capability) => typeof row[capability] !== 'boolean')
    )
      throw new Error('INVALID_PERMISSIONS');
  }
  return structuredClone(permissions);
}
export type FederationPeer = {
  origin: string;
  name: string;
  kid: string;
  publicKey: string;
  approved: boolean;
  discovered?: boolean;
  participationBlocked?: boolean;
  receiveRanked?: boolean;
  receiveCasual?: boolean;
  revision: number;
};
export type FederationPolicy = {
  id: string;
  instanceId: string;
  peerOrigin: string;
  peerInstanceId: string;
  permissions: FederationPermissions;
  revision: number;
};
export type FederationOverview = {
  administrator: boolean;
  admission: { mode: 'approved' | 'unblocked'; revision: number };
  peers: FederationPeer[];
  policies: FederationPolicy[];
  metadata: {
    instanceId: string;
    peerOrigin: string;
    payload: FederationMetadata;
    nextCursor: string | null;
    lastSuccessAt: number;
    errorCode: string | null;
  }[];
  jobs: {
    instanceId: string;
    peerOrigin: string;
    nextAttemptAt: number;
    failures: number;
    errorCode: string | null;
  }[];
  deliveries?: {
    eventId: string;
    instanceId: string;
    peerOrigin: string;
    attempts: number;
    nextAttemptAt: number;
    receivedAt: number | null;
    appliedAt: number | null;
    errorCode: string | null;
    quarantined: boolean;
  }[];
  controls?: {
    eventId: string;
    peerOrigin: string;
    attempts: number;
    nextAttemptAt: number;
    receivedAt: number | null;
    appliedAt: number | null;
    errorCode: string | null;
    quarantined: boolean;
  }[];
};

export type FederationMetadata = {
  snapshot: string;
  sourceInstanceId: string;
  organization: { id: string; name: string };
  instances: {
    id: string;
    name: string;
    ranked: boolean;
    casual: boolean;
    permissions: FederationPermissions;
  }[];
  nextCursor: string | null;
};

export type ExternalInstanceDirectory = {
  organizationId: string;
  peers: { origin: string; name: string; approved: boolean }[];
  sources: { id: string; name: string }[];
  instances: {
    peerOrigin: string;
    instanceId: string;
    name: string;
    organization: string;
    ranked: boolean;
    casual: boolean;
    favorite: boolean;
    available: boolean;
    sources: { id: string; name: string; ranked: boolean; casual: boolean }[];
  }[];
};
