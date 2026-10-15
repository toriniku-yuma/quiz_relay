import type {
  Command,
  Panel,
  Player,
  Reply,
  RoomEvent,
  Snapshot,
} from '../../shared/game.ts';
import { settings } from '../../shared/settings.ts';
import type { MatchDefinition } from '../catalog/definition.ts';
import type { MatchKind } from '../results/rating.ts';
import { makeResultRecord, type ResultRecord } from '../results/record.ts';
import {
  answerReadings,
  choicesFor,
  graphemes,
  orderQuestions,
  type Question,
  readingChoices,
} from './questions.ts';
import { appendEvent } from './recovery.ts';
import { type Rules, rules } from './rules.ts';

export { rules } from './rules.ts';

export type State = {
  parentRoomId?: string;
  reviewExpired?: boolean;
  guestNamesExpired?: boolean;
  answerStats: {
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
    sharedSource?: Question['sharedSource'];
    difficulty?: number;
    correct: boolean;
    participants: string[];
  }[];
  matchKind: MatchKind;
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
  if (definition && /^authored-(band-[0-2]|casual)$/.test(definition.competition.id))
    source = orderQuestions(
      source,
      definition.kind === 'casual' ? 2 : Number(definition.competition.id.slice(-1)),
      definition.selection?.weights,
      definition.selection?.categories,
    );
  if (definition?.kind === 'room') {
    source = [...source];
    for (let i = source.length - 1; i > 0; i--) {
      const j = Math.floor(
        (crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32) * (i + 1),
      );
      [source[i], source[j]] = [source[j], source[i]];
    }
  }
  const question = source[questionIndex];
  if (
    !question ||
    !Number.isInteger(playersRequired) ||
    playersRequired < 2 ||
    playersRequired > (definition?.kind === 'room' ? 8 : 4) ||
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
    matchKind: definition ? (definition.kind ?? 'ranked') : 'development',
    rules: structuredClone(fixedRules),
    ...(definition
      ? {
          definition: {
            ...(definition.kind ? { kind: definition.kind } : {}),
            ...(definition.original ? { original: true } : {}),
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
    (candidateQuestion) => candidateQuestion.id === state.question.id,
  );
  return {
    ...(state.matchKind === 'room'
      ? {
          roomRules: {
            winMode: state.rules.winMode ?? 'target',
            count:
              state.rules.winMode === 'questions'
                ? (state.rules.questionLimit ?? 7)
                : state.rules.correctAnswersToWin,
            mistakes: state.rules.noDisqualification
              ? null
              : state.rules.mistakesToDisqualify,
          },
        }
      : {}),
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
    kind: state.matchKind,
    questionCount:
      state.rules.winMode === 'questions'
        ? Math.min(
            state.questions.length,
            state.rules.questionLimit ?? state.questions.length,
          )
        : state.questions.length,
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
    .filter(
      (participant) => !participant.disqualified && participant.role !== 'presenter',
    )
    .map((participant) => participant.id);
  if (player && result !== 'unanswered')
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
      player.disqualified =
        !state.rules.noDisqualification &&
        player.mistakes >= state.rules.mistakesToDisqualify;
    }
  }

  state.judgment = { actorId: state.holder, result };
  if (
    answeringPlayers(state).filter((player) => !player.disqualified).length >=
      (state.matchKind === 'room' ? 1 : 2) &&
    (result === 'correct' ||
      result === 'unanswered' ||
      answeringPlayers(state).every((player) => player.locked || player.disqualified) ||
      (state.matchKind === 'room' &&
        answeringPlayers(state).filter((participant) => !participant.disqualified)
          .length === 1))
  ) {
    const question = state.question;
    state.completedQuestions ??= [];
    if (
      !state.completedQuestions.some(
        (candidateQuestion) => candidateQuestion.id === question.id,
      )
    )
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
        ...(question.sharedSource ? { sharedSource: question.sharedSource } : {}),
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
    state.rules.winMode !== 'questions' &&
    player.correct >= state.rules.correctAnswersToWin
  )
    finish(state, 'target_reached', player.id, now);
}

export function advance(state: State, now: number, nextByPresenter = false) {
  if (checkInvalid(state, now)) {
    changed(state, now);
    return true;
  }
  if (state.reconnect || state.deadline === null || now < state.deadline) return false;
  if (
    state.phase === 'JUDGED' &&
    questionEnded(state) &&
    !nextByPresenter &&
    state.players.some((player) => player.role === 'presenter' && player.connected)
  )
    return false;

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
    if (questionEnded(state)) {
      if (
        state.questionIndex + 1 >= state.questions.length ||
        (state.rules.winMode === 'questions' &&
          state.questionIndex + 1 >= (state.rules.questionLimit ?? 7))
      ) {
        const eligible = answeringPlayers(state).filter(
          ({ disqualified }) => !disqualified,
        );
        const best = Math.max(...eligible.map(({ correct }) => correct));
        const leaders = eligible.filter(({ correct }) => correct === best);
        finish(
          state,
          state.rules.winMode === 'questions' &&
            state.questionIndex + 1 >= (state.rules.questionLimit ?? 7)
            ? 'question_limit'
            : 'exhausted',
          leaders.length === 1 ? leaders[0].id : null,
          now,
        );
      } else {
        state.questionIndex++;
        if (state.matchKind === 'room') state.commands = {};
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
  const fingerprint = commandFingerprint(command);
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
  // Room receipts are stored separately by GameRoom; this bound covers only the current question.
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
  else if (command.type === 'next') {
    if (
      player.role !== 'presenter' ||
      state.phase !== 'JUDGED' ||
      !questionEnded(state) ||
      !advance(state, now, true)
    )
      code = 'NEXT_REJECTED';
  } else if (player.role === 'presenter') code = 'PRESENTER_CANNOT_ANSWER';
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

export function commandFingerprint(command: Command) {
  return JSON.stringify([
    command.matchId,
    command.questionId,
    command.type,
    command.payload.attemptId,
    command.payload.panelId,
    command.payload.choiceId,
  ]);
}

function isActive(state: State) {
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
  state.result = { reason, winnerId, finishedAt: now };
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
  const eligible = answeringPlayers(state).filter(({ disqualified }) => !disqualified);
  if (eligible.length <= 1) {
    finish(
      state,
      state.matchKind === 'room' && eligible.length === 1
        ? 'last_remaining'
        : 'disqualifications',
      state.matchKind === 'room' && eligible.length === 1 ? eligible[0].id : null,
      now,
    );
    return true;
  }
  return false;
}

export function changed(state: State, now: number) {
  if (!state.buzzClock || state.buzzClock.questionId !== state.question.id)
    state.buzzClock = { questionId: state.question.id, elapsed: 0, since: null };
  const clock = state.buzzClock;
  if (clock.since !== null) clock.elapsed += Math.max(0, now - clock.since);
  clock.since = state.phase === 'REVEALING' && !state.reconnect ? now : null;
  state.roomSeq++;
  const current = snapshot(state);
  state.events = appendEvent(state.events, state.publicState, current, now);
  state.publicState = current;
}

export function updateConnections(state: State, connected: Set<string>, now: number) {
  let updated = false;
  for (const player of state.players) {
    const present = !player.forfeited && connected.has(player.id);
    if (player.connected !== present) {
      player.connected = present;
      updated = true;
    }
  }
  updated = checkInvalid(state, now) || updated;
  if (isActive(state)) {
    const answerersConnected = answeringPlayers(state).filter(
      (player) => !player.forfeited && connected.has(player.id),
    ).length;
    if (answerersConnected <= 1 && !state.reconnect) {
      state.reconnect = {
        deadline: now + (state.rules.reconnectGraceMs ?? rules.reconnectGraceMs),
        remaining: state.deadline === null ? null : Math.max(0, state.deadline - now),
      };
      updated = true;
    } else if (answerersConnected >= 2 && state.reconnect) {
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

export const answeringPlayers = (state: State) =>
  state.players.filter((player) => player.role !== 'presenter');
export function forfeitPlayer(state: State, actor: string, now: number) {
  if (!isActive(state)) return;
  const player = state.players.find((candidatePlayer) => candidatePlayer.id === actor);
  if (!player || player.forfeited) return;
  player.forfeited = true;
  player.connected = false;
  player.locked = true;
  if (player.role !== 'presenter') player.disqualified = true;
  if (state.holder === actor) {
    state.holder = null;
    state.panel = null;
    state.response = null;
    state.judgment = null;
    state.phase = 'REVEALING';
    state.deadline =
      now +
      (state.revealed === graphemes(state.question.text).length
        ? state.waitRemaining
        : state.rules.revealIntervalMs);
    if (state.reconnect) state.reconnect.remaining = state.deadline - now;
  }
  checkInvalid(state, now);
  changed(state, now);
}
export function questionEnded(state: State) {
  return (
    state.judgment?.result === 'correct' ||
    state.judgment?.result === 'unanswered' ||
    answeringPlayers(state).every((player) => player.locked || player.disqualified)
  );
}
