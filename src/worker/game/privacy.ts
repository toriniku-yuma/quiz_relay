import type { MatchDefinition } from '../catalog/definition';
import type { State } from './state';

export function reviewDeadline(state: State) {
  if (state.reviewExpired || !state.completed || state.result?.storage !== 'confirmed')
    return;
  return state.result.finishedAt + 365 * 86400000;
}

export function expireReview(state: State, now: number) {
  const deadline = reviewDeadline(state);
  if (deadline === undefined || now < deadline) return false;
  state.reviewExpired = true;
  state.questions = [];
  state.question = { id: state.question.id, text: '', answer: '', explanation: '' };
  delete state.completedQuestions;
  if (state.completed) delete state.completed.completedQuestions;
  state.panel = null;
  state.response = null;
  state.events = [];
  state.publicState = null;
  state.commands = {};
  return true;
}

export function anonymizeDefinition(
  definition: Pick<MatchDefinition, 'selection'> | undefined,
  questionIds: Set<string>,
) {
  const names = definition?.selection?.authorNames;
  if (names)
    for (const id of Object.keys(names))
      if (questionIds.has(id)) names[id] = '退会ユーザー';
}

export function anonymizeState(state: State, actorId: string, questionIds: Set<string>) {
  const playerName = (players: { id: string; name: string }[]) => {
    for (const player of players) if (player.id === actorId) player.name = '退会ユーザー';
  };
  const authorName = (question: {
    id: string;
    seriesId?: string;
    authorName?: string;
  }) => {
    if (
      question.authorName &&
      (questionIds.has(question.id) || questionIds.has(question.seriesId ?? ''))
    )
      question.authorName = '退会ユーザー';
  };
  playerName(state.players);
  for (const question of state.questions) authorName(question);
  authorName(state.question);
  for (const question of state.completedQuestions ?? []) authorName(question);
  anonymizeDefinition(state.definition, questionIds);
  if (state.completed) {
    playerName(state.completed.players);
    for (const question of state.completed.completedQuestions ?? []) authorName(question);
    anonymizeDefinition(state.completed.definition, questionIds);
  }
  // Deltas may omit the question/actor identifier. Regenerate a full snapshot instead of guessing.
  state.events = [];
  state.publicState = null;
}
