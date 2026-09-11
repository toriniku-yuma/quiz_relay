import type { Command, Panel, Player, Reply, Snapshot } from '../../shared/game';
import { choicesFor, graphemes, type Question, questions } from './questions';

export const rules = {
  revealIntervalMs: 100,
  characterAnswerTimeMs: 3000,
  judgedDisplayMs: 2000,
  fullRevealWaitMs: 10000,
} as const;

export type State = {
  rules: typeof rules;
  matchId: string;
  question: Question;
  players: Player[];
  playersRequired: number;
  phase: Snapshot['phase'];
  roomSeq: number;
  revealed: number;
  deadline: number | null;
  holder: string | null;
  panel: Panel | null;
  waitRemaining: number;
  judgment: Snapshot['judgment'];
  commands: Record<string, { fingerprint: string; reply: Reply }>;
};

export function createState(questionIndex: number, playersRequired: number): State {
  const question = questions[questionIndex];
  if (
    !question ||
    !Number.isInteger(playersRequired) ||
    playersRequired < 2 ||
    playersRequired > 4
  )
    throw new Error('INVALID_SETUP');

  for (const letter of graphemes(question.answer)) choicesFor(letter);

  return {
    rules: { ...rules },
    matchId: crypto.randomUUID(),
    question,
    players: [],
    playersRequired,
    phase: 'WAITING',
    roomSeq: 0,
    revealed: 0,
    deadline: null,
    holder: null,
    panel: null,
    waitRemaining: rules.fullRevealWaitMs,
    judgment: null,
    commands: {},
  };
}

export function snapshot(state: State): Snapshot {
  return {
    matchId: state.matchId,
    questionId: state.question.id,
    roomSeq: state.roomSeq,
    phase: state.phase,
    text: graphemes(state.question.text).slice(0, state.revealed).join(''),
    players: state.players,
    playersRequired: state.playersRequired,
    holder: state.holder,
    deadline: state.deadline,
    judgment: state.judgment,
  };
}

function activatePanel(state: State, now: number, position: number, attemptId: string) {
  state.panel = {
    attemptId,
    panelId: crypto.randomUUID(),
    position,
    choices: choicesFor(graphemes(state.question.answer)[position]),
    deadline: now + state.rules.characterAnswerTimeMs,
  };
  state.deadline = state.panel.deadline;
}

function judge(
  state: State,
  result: 'correct' | 'wrong' | 'timeout' | 'unanswered',
  now: number,
) {
  const player = state.players.find(({ id }) => id === state.holder);
  if (player) {
    if (result === 'correct') player.correct++;
    else {
      player.mistakes++;
      player.locked = true;
    }
  }

  state.judgment = { actorId: state.holder, result };
  state.phase = 'JUDGED';
  state.panel = null;
  state.holder = null;
  state.deadline = now + state.rules.judgedDisplayMs;
}

export function advance(state: State, now: number) {
  if (state.deadline === null || now < state.deadline) return false;

  if (state.phase === 'ANSWERING') judge(state, 'timeout', now);
  else if (state.phase === 'REVEALING') {
    const length = graphemes(state.question.text).length;
    if (state.revealed === length) judge(state, 'unanswered', now);
    else {
      // 復帰時も一度に未表示本文を送り出さず、現在位置から再開する。
      state.revealed++;
      state.deadline =
        now +
        (state.revealed === length ? state.waitRemaining : state.rules.revealIntervalMs);
    }
  } else if (state.phase === 'JUDGED') {
    if (
      state.judgment?.result === 'correct' ||
      state.judgment?.result === 'unanswered' ||
      state.players.every(({ locked }) => locked)
    ) {
      state.phase = 'ENDED';
      state.deadline = null;
    } else {
      state.phase = 'REVEALING';
      state.deadline =
        now +
        (state.revealed === graphemes(state.question.text).length
          ? state.waitRemaining
          : state.rules.revealIntervalMs);
    }
  } else return false;

  state.roomSeq++;
  return true;
}

export function adjudicate(
  state: State,
  actorId: string,
  command: Command,
  now: number,
): Reply {
  const key = `${actorId}:${command.commandId}`;
  const fingerprint = JSON.stringify([
    command.matchId,
    command.questionId,
    command.type,
    command.payload.attemptId,
    command.payload.panelId,
    command.payload.choiceId,
  ]);
  const previous = state.commands[key];
  if (previous)
    return previous.fingerprint === fingerprint
      ? previous.reply
      : {
          commandId: command.commandId,
          ok: false,
          code: 'COMMAND_CONFLICT',
          roomSeq: state.roomSeq,
        };

  advance(state, now);
  const player = state.players.find(({ id }) => id === actorId);
  let code = 'OK';
  // ponytail: 1Aは1問・参加者ごとに128件を保存。1Bで試合単位の保持へ拡張する。
  if (
    Object.keys(state.commands).filter((key) => key.startsWith(`${actorId}:`)).length >=
    128
  )
    return {
      commandId: command.commandId,
      ok: false,
      code: 'COMMAND_LIMIT',
      roomSeq: state.roomSeq,
    };
  if (
    !player ||
    command.matchId !== state.matchId ||
    command.questionId !== state.question.id
  )
    code = 'STALE_COMMAND';
  else if (command.type === 'buzz') {
    if (state.phase !== 'REVEALING' || player.locked) code = 'BUZZ_REJECTED';
    else {
      if (state.revealed === graphemes(state.question.text).length)
        state.waitRemaining = Math.max(0, (state.deadline ?? now) - now);
      state.phase = 'ANSWERING';
      state.holder = actorId;
      state.judgment = null;
      activatePanel(state, now, 0, crypto.randomUUID());
      state.roomSeq++;
    }
  } else {
    const panel = state.panel;
    if (
      state.phase !== 'ANSWERING' ||
      state.holder !== actorId ||
      !panel ||
      command.payload.attemptId !== panel.attemptId ||
      command.payload.panelId !== panel.panelId
    )
      code = 'PANEL_REJECTED';
    else {
      const choice = panel.choices.find(({ id }) => id === command.payload.choiceId);
      if (!choice) code = 'CHOICE_REJECTED';
      else {
        const answer = graphemes(state.question.answer);
        if (choice.text !== answer[panel.position]) judge(state, 'wrong', now);
        else if (panel.position === answer.length - 1) judge(state, 'correct', now);
        else activatePanel(state, now, panel.position + 1, panel.attemptId);
        state.roomSeq++;
      }
    }
  }

  const reply = {
    commandId: command.commandId,
    ok: code === 'OK',
    code,
    roomSeq: state.roomSeq,
  };
  state.commands[key] = { fingerprint, reply };
  return reply;
}
