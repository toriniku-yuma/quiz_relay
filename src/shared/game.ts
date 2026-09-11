export type Phase = 'WAITING' | 'REVEALING' | 'ANSWERING' | 'JUDGED' | 'ENDED';

export type Player = {
  id: string;
  name: string;
  correct: number;
  mistakes: number;
  locked: boolean;
};

export type Panel = {
  attemptId: string;
  panelId: string;
  position: number;
  choices: { id: string; text: string }[];
  deadline: number;
};

export type Snapshot = {
  matchId: string;
  questionId: string;
  roomSeq: number;
  phase: Phase;
  text: string;
  players: Player[];
  playersRequired: number;
  holder: string | null;
  deadline: number | null;
  judgment: {
    actorId: string | null;
    result: 'correct' | 'wrong' | 'timeout' | 'unanswered';
  } | null;
};

export type Command = {
  commandId: string;
  matchId: string;
  questionId: string;
  type: 'buzz' | 'choose';
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
  | { type: 'ack'; reply: Reply }
  | { type: 'error'; code: string };
