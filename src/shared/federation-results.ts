export type FederatedResult = {
  version: 1;
  eventId: string;
  matchId: string;
  reservationId: string;
  hostInstanceId: string;
  hostInstanceName: string;
  sourceOrganizationId: string;
  sourceActorId: string;
  startedAt: number;
  finishedAt: number;
  kind: 'ranked' | 'casual' | 'room';
  reason: string;
  winnerId: string | null;
  selfId: string;
  definition: {
    competition: { owner: string; id: string; version: number };
    rulesHash: string;
    manifestHash: string;
  };
  players: {
    id: string;
    name: string;
    correct: number;
    mistakes: number;
    ratingDelta: number;
    disqualified: boolean;
    guest?: boolean;
    role?: 'presenter';
    forfeited?: boolean;
  }[];
};
