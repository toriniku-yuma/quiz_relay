export type ResultsOverview = {
  ranking: { actorId: string; name: string; rating: number; rank: number }[];
  history: {
    resultId: string;
    finishedAt: string;
    reason: string;
    winnerId: string | null;
    ratingDelta: number;
    outcome: 'win' | 'loss' | 'draw' | 'invalid';
    players: {
      id: string;
      name: string;
      correct: number;
      mistakes: number;
      ratingDelta: number;
    }[];
  }[];
};
