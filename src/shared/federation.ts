// Hourly refresh plus bounded scheduler/transport jitter. Failed reads
// invalidate immediately; this is only the maximum lifetime of a successful read.
export const FEDERATION_FRESH_MS = 3600000 + 120000;
export type FederationPeer = {
  origin: string;
  name: string;
  kid: string;
  publicKey: string;
  approved: boolean;
  discovered: boolean;
  participationBlocked: boolean;
  receiveRanked: boolean;
  receiveCasual: boolean;
  revision: number;
};
// Per peer-instance pair, a policy only controls question sharing in each direction.
export type QuestionSharingPolicy = { sendQuestions: boolean; receiveQuestions: boolean };
type FederationPolicy = QuestionSharingPolicy & {
  id: string;
  instanceId: string;
  peerOrigin: string;
  peerInstanceId: string;
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
  // ranked/casual combine the instance's availability with the host's admission of the requester.
  instances: {
    id: string;
    name: string;
    ranked: boolean;
    casual: boolean;
  }[];
  nextCursor: string | null;
};

export type ExternalInstanceDirectory = {
  organizationId: string;
  peers: { origin: string; name: string; approved: boolean }[];
  instances: {
    peerOrigin: string;
    instanceId: string;
    name: string;
    organization: string;
    ranked: boolean;
    casual: boolean;
    favorite: boolean;
    available: boolean;
  }[];
};
