import type {
  Command,
  Panel,
  Player,
  Reply,
  RoomEvent,
  Snapshot,
} from '../../shared/game';
import { settings } from '../../shared/settings';
import type { MatchDefinition } from '../catalog/definition';
import type { MatchKind } from '../results/rating';
import { makeResultRecord, type ResultRecord } from '../results/record';
import {
  answerReadings,
  choicesFor,
  graphemes,
  orderQuestions,
  type Question,
  readingChoices,
} from './questions';
import { appendEvent } from './recovery';
import { type Rules, rules } from './rules';

export { rules } from './rules';

export type State = {
  reviewExpired?: boolean;
  answerStats?: {
    actorId: string;
    result: 'correct' | 'wrong' | 'timeout';
    elapsedMs: number | null;
  }[];
  buzzClock?: { questionId: string; elapsed: number; since: number | null };
  currentBuzzMs?: number | null;
  startingRatings?: Record<string, number>;
  questionParticipants?: string[];
  completedQuestions?: {
    authorName?: string;
    id: string;
    text: string;
    displayAnswer: string;
    readings: string[];
    explanation: string;
    source: string;
    categoryId?: string;
    seriesId?: string;
    generation?: string;
    difficulty?: number;
    correct: boolean;
    participants: string[];
  }[];
  matchKind?: MatchKind;
  startedAt?: number;
  completed?: ResultRecord;
  rules: Rules;
  definition?: Omit<MatchDefinition, 'rules' | 'questions'>;
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
  source: Question[],
  questionIndex: number,
  playersRequired: number,
  showSelections = true,
  definition?: MatchDefinition,
): State {
  const fixedRules = definition?.rules ?? { ...rules, showSelections };
  if (definition?.selection?.authorNames)
    source = source.map((question) => ({
      ...question,
      ...(definition.selection?.authorNames?.[question.id]
        ? { authorName: definition.selection.authorNames[question.id] }
        : {}),
    }));
  if (definition && /^authored-band-[0-2]$/.test(definition.competition.id))
    source = orderQuestions(
      source,
      Number(definition.competition.id.slice(-1)),
      definition.selection?.weights,
      definition.selection?.categories,
    );
  const question = source[questionIndex];
  if (
    !question ||
    !Number.isInteger(playersRequired) ||
    playersRequired < 2 ||
    playersRequired > 4 ||
    (definition &&
      (questionIndex !== 0 || playersRequired !== definition.playersPerMatch))
  )
    throw new Error('INVALID_SETUP');

  for (const item of source) {
    for (const letter of graphemes(item.answer))
      choicesFor(letter, fixedRules.choiceCount, item.distractors);
  }

  return {
    answerStats: [],
    matchKind: definition ? 'ranked' : 'development',
    rules: structuredClone(fixedRules),
    ...(definition
      ? {
          definition: {
            ...(definition.selection
              ? { selection: structuredClone(definition.selection) }
              : {}),
            competition: structuredClone(definition.competition),
            ruleset: structuredClone(definition.ruleset),
            questionSet: structuredClone(definition.questionSet),
            rulesHash: definition.rulesHash,
            manifestHash: definition.manifestHash,
            playersPerMatch: definition.playersPerMatch,
          },
        }
      : {}),
    response: null,
    reconnect: null,
    matchId: crypto.randomUUID(),
    question: structuredClone(question),
    questions: structuredClone([
      ...source.slice(questionIndex),
      ...source.slice(0, questionIndex),
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
    waitRemaining: fixedRules.fullRevealWaitMs,
    judgment: null,
    commands: {},
  };
}

export function snapshot(state: State): Snapshot {
  const completedQuestion = state.completedQuestions?.find(
    (q) => q.id === state.question.id,
  );
  return {
    ...(completedQuestion
      ? {
          revealedAnswer: {
            displayAnswer: completedQuestion.displayAnswer,
            readings: completedQuestion.readings,
            explanation: completedQuestion.explanation,
            source: completedQuestion.source,
            ...(completedQuestion.authorName
              ? { authorName: completedQuestion.authorName }
              : {}),
          },
        }
      : { revealedAnswer: null }),
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
    choices: state.question.readings
      ? readingChoices(state.question, state.response?.text ?? '')
      : choicesFor(
          graphemes(state.question.answer)[position],
          state.rules.choiceCount ?? 4,
          state.question.distractors,
        ),
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
  state.questionParticipants ??= state.players
    .filter((p) => !p.disqualified)
    .map((p) => p.id);
  if (player && result !== 'unanswered' && state.answerStats)
    state.answerStats.push({
      actorId: player.id,
      result,
      elapsedMs: state.currentBuzzMs ?? null,
    });
  if (player) {
    if (result === 'correct') player.correct++;
    else {
      player.mistakes++;
      player.locked = true;
      player.disqualified = player.mistakes >= state.rules.mistakesToDisqualify;
    }
  }

  state.judgment = { actorId: state.holder, result };
  if (
    state.players.filter((player) => !player.disqualified).length >= 2 &&
    (result === 'correct' ||
      result === 'unanswered' ||
      state.players.every((player) => player.locked || player.disqualified))
  ) {
    const question = state.question;
    state.completedQuestions ??= [];
    if (!state.completedQuestions.some((q) => q.id === question.id))
      state.completedQuestions.push({
        ...(question.authorName ? { authorName: question.authorName } : {}),
        id: question.id,
        text: question.text,
        displayAnswer: question.displayAnswer ?? question.answer,
        readings: answerReadings(question),
        explanation: question.explanation,
        source:
          'source' in question && typeof question.source === 'string'
            ? question.source
            : '',
        ...(question.categoryId ? { categoryId: question.categoryId } : {}),
        ...(question.seriesId ? { seriesId: question.seriesId } : {}),
        ...(question.generation ? { generation: question.generation } : {}),
        ...(question.difficulty !== undefined ? { difficulty: question.difficulty } : {}),
        correct: result === 'correct',
        participants: [...state.questionParticipants],
      });
  }
  state.phase = 'JUDGED';
  state.panel = null;
  state.holder = null;
  state.deadline = now + state.rules.judgedDisplayMs;
  if (
    !checkInvalid(state, now) &&
    player &&
    player.correct >= state.rules.correctAnswersToWin
  )
    finish(state, 'target_reached', player.id, now);
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
        state.questionParticipants = undefined;
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
    settings.game.maxCommandsPerActor
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
      state.currentBuzzMs = state.buzzClock
        ? state.buzzClock.elapsed +
          (state.buzzClock.since === null ? 0 : Math.max(0, now - state.buzzClock.since))
        : null;
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
        const answers = answerReadings(state.question);
        const entered = state.response?.text ?? '';
        if (!answers.some((answer) => answer.startsWith(entered)))
          judge(state, 'wrong', now);
        else if (answers.includes(entered)) judge(state, 'correct', now);
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
  state.completed = makeResultRecord(state, state.result);
  if (state.completed) {
    state.result.storage = 'pending';
    state.result.ratingChanges = state.completed.players.map((player) => ({
      actorId: player.id,
      delta: player.ratingDelta,
    }));
  }
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
  if (state.answerStats) {
    if (!state.buzzClock || state.buzzClock.questionId !== state.question.id)
      state.buzzClock = { questionId: state.question.id, elapsed: 0, since: null };
    const clock = state.buzzClock;
    if (clock.since !== null) clock.elapsed += Math.max(0, now - clock.since);
    clock.since = state.phase === 'REVEALING' && !state.reconnect ? now : null;
  }
  state.roomSeq++;
  const current = snapshot(state);
  state.events = appendEvent(state.events, state.publicState, current, now);
  state.publicState = current;
}

export function updateConnections(state: State, connected: Set<string>, now: number) {
  let updated = false;
  for (const player of state.players) {
    const present = connected.has(player.id);
    if (player.connected !== present) {
      player.connected = present;
      updated = true;
    }
  }
  updated = checkInvalid(state, now) || updated;
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
