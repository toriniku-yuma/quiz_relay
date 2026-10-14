export type Phase =
  | 'WAITING'
  | 'REVEALING'
  | 'ANSWERING'
  | 'JUDGED'
  | 'FINISHED'
  | 'INVALID';

export type Player = {
  forfeited?: boolean;
  role?: 'presenter';
  guest?: boolean;
  id: string;
  name: string;
  correct: number;
  mistakes: number;
  locked: boolean;
  disqualified: boolean;
  connected: boolean;
};
export type Panel = {
  attemptId: string;
  panelId: string;
  position: number;
  choices: { id: string; text: string }[];
  deadline: number;
};
export type Result = {
  id: string;
  winnerId: string | null;
  reason:
    | 'target_reached'
    | 'exhausted'
    | 'question_limit'
    | 'last_remaining'
    | 'connections'
    | 'disqualifications';
  finishedAt: number;
  storage?: 'pending' | 'confirmed' | 'conflict';
  ratingChanges?: { actorId: string; delta: number }[];
};
export type Snapshot = {
  kind?: 'ranked' | 'casual' | 'room' | 'development';
  roomRules?: { winMode: 'target' | 'questions'; count: number; mistakes: number | null };
  revealedAnswer?: {
    authorName?: string;
    displayAnswer: string;
    readings: string[];
    explanation: string;
    source?: string;
  } | null;
  matchId: string;
  questionId: string;
  questionNumber: number;
  questionCount: number;
  roomSeq: number;
  reconnect: { deadline: number; remaining: number | null } | null;
  phase: Phase;
  text: string;
  players: Player[];
  playersRequired: number;
  holder: string | null;
  showSelections: boolean;
  response: { actorId: string; text: string } | null;
  deadline: number | null;
  result: Result | null;
  judgment: {
    actorId: string | null;
    result: 'correct' | 'wrong' | 'timeout' | 'unanswered';
  } | null;
};
export type RoomEvent = { roomSeq: number; at: number; changes: Partial<Snapshot> };
export type Command = {
  commandId: string;
  matchId: string;
  questionId: string;
  type: 'buzz' | 'choose' | 'next';
  payload: { attemptId?: string; panelId?: string; choiceId?: string };
};
export type Reply = { commandId: string; ok: boolean; code: string; roomSeq: number };
export type GameMessage =
  | {
      type: 'state';
      snapshot: Snapshot;
      panel: Panel | null;
      actorId: string;
      serverTime: number;
    }
  | {
      type: 'delta';
      matchId: string;
      fromSeq: number;
      roomSeq: number;
      events: RoomEvent[];
      panel: Panel | null;
      actorId: string;
      serverTime: number;
    }
  | { type: 'ack'; reply: Reply }
  | { type: 'error'; code: string };
