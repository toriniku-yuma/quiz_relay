import type {
  Command,
  Panel,
  Player,
  Reply,
  RoomEvent,
  Snapshot,
} from '../../shared/game';
import { choicesFor, graphemes, type Question, questions } from './questions';
import { appendEvent } from './recovery';

export const rules = {
  revealIntervalMs: 100,
  characterAnswerTimeMs: 3000,
  judgedDisplayMs: 2000,
  fullRevealWaitMs: 10000,
  correctAnswersToWin: 7,
  mistakesToDisqualify: 3,
  reconnectGraceMs: 30000,
} as const;

export type State = {
  rules: typeof rules & { showSelections: boolean };
  response: Snapshot['response'];
  reconnect: Snapshot['reconnect'];
  events: RoomEvent[];
  publicState: Snapshot | null;
  result: Snapshot['result'];
  questionIndex: number;
  questions: Question[];
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

export function createState(
  questionIndex: number,
  playersRequired: number,
  showSelections = true,
): State {
  const question = questions[questionIndex];
  if (
    !question ||
    !Number.isInteger(playersRequired) ||
    playersRequired < 2 ||
    playersRequired > 4
  )
    throw new Error('INVALID_SETUP');

  for (const item of questions) {
    for (const letter of graphemes(item.answer)) choicesFor(letter);
  }

  return {
    rules: { ...rules, showSelections },
    response: null,
    reconnect: null,
    matchId: crypto.randomUUID(),
    question,
    questions: structuredClone([
      ...questions.slice(questionIndex),
      ...questions.slice(0, questionIndex),
    ]),
    questionIndex: 0,
    events: [],
    publicState: null,
    result: null,
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
    questionNumber: state.questionIndex + 1,
    questionCount: state.questions.length,
    result: state.result ? { ...state.result } : null,
    roomSeq: state.roomSeq,
    reconnect: state.reconnect ? { ...state.reconnect } : null,
    phase: state.phase,
    text: graphemes(state.question.text).slice(0, state.revealed).join(''),
    players: state.players.map((player) => ({ ...player })),

    playersRequired: state.playersRequired,
    holder: state.holder,
    showSelections: state.rules.showSelections,
    response: state.rules.showSelections && state.response ? { ...state.response } : null,
    deadline: state.deadline,
    judgment: state.judgment ? { ...state.judgment } : null,
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
      player.disqualified = player.mistakes >= state.rules.mistakesToDisqualify;
    }
  }

  state.judgment = { actorId: state.holder, result };
  state.phase = 'JUDGED';
  state.panel = null;
  state.holder = null;
  state.deadline = now + state.rules.judgedDisplayMs;
  if (
    !checkInvalid(state, now) &&
    player &&
    player.correct >= state.rules.correctAnswersToWin
  )
    finish(state, 'seven_correct', player.id, now);
}

export function advance(state: State, now: number) {
  if (checkInvalid(state, now)) {
    changed(state, now);
    return true;
  }
  if (state.reconnect || state.deadline === null || now < state.deadline) return false;

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
      state.players.every(({ locked, disqualified }) => locked || disqualified)
    ) {
      if (state.questionIndex + 1 >= state.questions.length) {
        const eligible = state.players.filter(({ disqualified }) => !disqualified);
        const best = Math.max(...eligible.map(({ correct }) => correct));
        const leaders = eligible.filter(({ correct }) => correct === best);
        finish(state, 'exhausted', leaders.length === 1 ? leaders[0].id : null, now);
      } else {
        state.questionIndex++;
        state.question = state.questions[state.questionIndex];
        state.revealed = 0;
        state.waitRemaining = state.rules.fullRevealWaitMs;
        state.judgment = null;
        state.response = null;
        for (const player of state.players) player.locked = player.disqualified;
        state.phase = 'REVEALING';
        state.deadline = now + state.rules.revealIntervalMs;
      }
    } else {
      state.phase = 'REVEALING';
      state.deadline =
        now +
        (state.revealed === graphemes(state.question.text).length
          ? state.waitRemaining
          : state.rules.revealIntervalMs);
    }
  } else return false;

  changed(state, now);
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
  // ponytail: ローカル12問は参加者ごとに256件まで保持。問題数拡張時は保存方式と上限を再評価する。
  if (
    Object.keys(state.commands).filter((key) => key.startsWith(`${actorId}:`)).length >=
    256
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
  else if (state.reconnect) code = 'RECONNECT_WAIT';
  else if (command.type === 'buzz') {
    if (state.phase !== 'REVEALING' || player.locked || player.disqualified)
      code = 'BUZZ_REJECTED';
    else {
      if (state.revealed === graphemes(state.question.text).length)
        state.waitRemaining = Math.max(0, (state.deadline ?? now) - now);
      state.phase = 'ANSWERING';
      state.holder = actorId;
      state.response = { actorId, text: '' };
      state.judgment = null;
      activatePanel(state, now, 0, crypto.randomUUID());
      changed(state, now);
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
        if (state.response) state.response.text += choice.text;
        const answer = graphemes(state.question.answer);
        if (choice.text !== answer[panel.position]) judge(state, 'wrong', now);
        else if (panel.position === answer.length - 1) judge(state, 'correct', now);
        else activatePanel(state, now, panel.position + 1, panel.attemptId);
        changed(state, now);
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

export function isActive(state: State) {
  return (
    state.phase === 'REVEALING' || state.phase === 'ANSWERING' || state.phase === 'JUDGED'
  );
}

function finish(
  state: State,
  reason: NonNullable<Snapshot['result']>['reason'],
  winnerId: string | null,
  now: number,
) {
  state.phase =
    reason === 'connections' || reason === 'disqualifications' ? 'INVALID' : 'FINISHED';
  state.result = { id: crypto.randomUUID(), reason, winnerId, finishedAt: now };
  state.holder = null;
  state.panel = null;
  state.deadline = null;
  state.reconnect = null;
}

function checkInvalid(state: State, now: number) {
  if (!isActive(state)) return false;
  if (state.reconnect && now >= state.reconnect.deadline) {
    finish(state, 'connections', null, now);
    return true;
  }
  if (state.players.filter(({ disqualified }) => !disqualified).length <= 1) {
    finish(state, 'disqualifications', null, now);
    return true;
  }
  return false;
}

export function changed(state: State, now: number) {
  state.roomSeq++;
  const current = snapshot(state);
  state.events = appendEvent(state.events, state.publicState, current, now);
  state.publicState = current;
}

export function updateConnections(state: State, connected: Set<string>, now: number) {
  let updated = checkInvalid(state, now);
  for (const player of state.players) {
    const present = connected.has(player.id);
    if (player.connected !== present) {
      player.connected = present;
      updated = true;
    }
  }
  if (isActive(state)) {
    if (connected.size <= 1 && !state.reconnect) {
      state.reconnect = {
        deadline: now + (state.rules.reconnectGraceMs ?? rules.reconnectGraceMs),
        remaining: state.deadline === null ? null : Math.max(0, state.deadline - now),
      };
      updated = true;
    } else if (connected.size >= 2 && state.reconnect) {
      state.deadline =
        state.reconnect.remaining === null ? null : now + state.reconnect.remaining;
      if (state.panel && state.deadline !== null) state.panel.deadline = state.deadline;
      state.reconnect = null;
      updated = true;
    }
  }
  if (updated) changed(state, now);
  return updated;
}
