export type ResultsOverview = {
  ranking: { actorId: string; name: string; rating: number; rank: number }[];
  history: {
    kind?: 'ranked' | 'casual' | 'room' | 'development';
    questions?: {
      authorName?: string;
      id: string;
      text: string;
      displayAnswer: string;
      readings: string[];
      explanation: string;
      source: string;
    }[];
    resultId: string;
    finishedAt: string;
    reason: string;
    winnerId: string | null;
    ratingDelta: number;
    outcome: 'win' | 'loss' | 'draw' | 'invalid' | 'presenter';
    players: {
      guest?: boolean;
      role?: 'presenter';
      id: string;
      name: string;
      correct: number;
      mistakes: number;
      ratingDelta: number;
    }[];
  }[];
};
