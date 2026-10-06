import { normalizeDisplayName } from '../../shared/profile.ts';
import { type QuestionSelection, readingIssues } from '../../shared/questions.ts';
import { validateBroughtQuestion } from '../../shared/rooms.ts';
import { graphemes, type Question } from '../game/questions.ts';
import { type Rules, validateRules } from '../game/rules.ts';
import { contentHash } from './hash.ts';

export type VersionRef = { owner: string; id: string; version: number };
export type FixedQuestion = Question & {
  version: number;
  distractors: string[];
  source: string;
  permission: string;
  demoAllowed: true;
};
export type MatchDefinition = {
  kind?: 'ranked' | 'casual' | 'room';
  original?: boolean;
  selection?: QuestionSelection;
  competition: VersionRef;
  ruleset: VersionRef;
  questionSet: VersionRef;
  rulesHash: string;
  manifestHash: string;
  playersPerMatch: number;
  rules: Rules;
  questions: FixedQuestion[];
};

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= max;

export function validateRef(value: unknown): VersionRef {
  if (
    !record(value) ||
    !text(value.owner, 256) ||
    !text(value.id, 64) ||
    !/^[a-zA-Z0-9_-]+$/.test(value.id) ||
    !Number.isSafeInteger(value.version) ||
    Number(value.version) < 1
  )
    throw new Error('INVALID_VERSION');

  const origin = new URL(value.owner);
  const internalOwner =
    /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      value.owner,
    );
  if (!internalOwner && (origin.protocol !== 'https:' || origin.origin !== value.owner))
    throw new Error('INVALID_VERSION');

  return { owner: value.owner, id: value.id, version: Number(value.version) };
}

export async function validateDefinition(value: unknown): Promise<MatchDefinition> {
  if (!record(value)) throw new Error('INVALID_DEFINITION');
  if (
    (value.kind !== undefined &&
      (typeof value.kind !== 'string' ||
        !['ranked', 'casual', 'room'].includes(value.kind))) ||
    (value.original !== undefined &&
      (typeof value.original !== 'boolean' || value.kind !== 'room'))
  )
    throw new Error('INVALID_DEFINITION');
  const selection = value.selection;
  if (selection !== undefined) {
    if (
      !record(selection) ||
      !Number.isInteger(selection.band) ||
      Number(selection.band) < 0 ||
      Number(selection.band) > 2 ||
      !Array.isArray(selection.boundaries) ||
      selection.boundaries.length !== 2 ||
      !selection.boundaries.every(Number.isFinite) ||
      selection.boundaries[0] >= selection.boundaries[1] ||
      !Array.isArray(selection.weights) ||
      selection.weights.length !== 3 ||
      selection.weights.some(
        (weight, index) =>
          !Number.isFinite(weight) ||
          weight < 0 ||
          (index > Number(selection.band) && weight !== 0),
      ) ||
      selection.weights.reduce((sum, weight) => sum + weight, 0) <= 0 ||
      !record(selection.categories) ||
      Object.values(selection.categories).some(
        (weight) => typeof weight !== 'number' || !Number.isFinite(weight) || weight < 0,
      ) ||
      !Number.isSafeInteger(selection.revision) ||
      Number(selection.revision) < 0 ||
      (selection.authorNames !== undefined &&
        (!record(selection.authorNames) ||
          Object.values(selection.authorNames).some(
            (name) => !text(name, 80) && normalizeDisplayName(name) === undefined,
          )))
    )
      throw new Error('INVALID_DEFINITION');
  }
  const competition = validateRef(value.competition);
  const ruleset = validateRef(value.ruleset);
  const questionSet = validateRef(value.questionSet);
  const rules = validateRules(value.rules);
  if (
    value.kind !== 'room' &&
    ['winMode', 'questionLimit', 'noDisqualification'].some((key) =>
      Object.hasOwn(rules, key),
    )
  )
    throw new Error('INVALID_DEFINITION');
  if (
    competition.owner !== ruleset.owner ||
    competition.owner !== questionSet.owner ||
    !Number.isInteger(value.playersPerMatch) ||
    Number(value.playersPerMatch) < 2 ||
    Number(value.playersPerMatch) > (value.kind === 'room' ? 8 : 4) ||
    !Array.isArray(value.questions) ||
    value.questions.length < 1 ||
    (value.questions.length > 100 &&
      !/^authored-(band-[0-2]|casual)$/.test(competition.id) &&
      value.kind !== 'room')
  )
    throw new Error('INVALID_DEFINITION');

  const questions = value.questions.map((item) =>
    validateQuestion(
      item,
      rules.choiceCount,
      value.kind === 'room' && value.original === true,
    ),
  );
  if (new Set(questions.map((question) => question.id)).size !== questions.length)
    throw new Error('INVALID_QUESTION');

  if (
    value.rulesHash !== (await contentHash(rules)) ||
    value.manifestHash !== (await contentHash(questions))
  )
    throw new Error('DEFINITION_HASH_MISMATCH');

  return {
    ...(value.kind !== undefined ? { kind: value.kind as MatchDefinition['kind'] } : {}),
    ...(value.original === true ? { original: true } : {}),
    ...(value.selection ? { selection: value.selection as QuestionSelection } : {}),
    competition,
    ruleset,
    questionSet,
    rulesHash: value.rulesHash as string,
    manifestHash: value.manifestHash as string,
    playersPerMatch: Number(value.playersPerMatch),
    rules,
    questions,
  };
}

export function validateQuestion(
  item: unknown,
  choiceCount: number,
  original = false,
): FixedQuestion {
  if (
    !record(item) ||
    !text(item.id, 64) ||
    !/^[a-zA-Z0-9_-]+$/.test(item.id) ||
    item.version !== 1 ||
    !(original ? typeof item.text === 'string' : text(item.text, 2000)) ||
    !text(item.answer, 64) ||
    !(original ? typeof item.explanation === 'string' : text(item.explanation, 2000)) ||
    !(original ? item.source === '' : text(item.source, 1000)) ||
    !text(item.permission, 1000) ||
    item.demoAllowed !== true ||
    !Array.isArray(item.distractors) ||
    item.distractors.length > 128
  )
    throw new Error('INVALID_QUESTION');
  if (original) {
    try {
      validateBroughtQuestion({
        text: item.text,
        displayAnswer: item.displayAnswer,
        readings: item.readings,
        explanation: item.explanation,
      });
    } catch {
      throw new Error('INVALID_QUESTION');
    }
  }
  const answer = item.answer.normalize('NFKC').trim();
  if (
    item.readings !== undefined &&
    (!Array.isArray(item.readings) ||
      item.readings.length < 1 ||
      item.readings.length > 8 ||
      item.readings.some((reading) => typeof reading !== 'string') ||
      !item.readings.includes(answer) ||
      readingIssues(item.readings).length)
  )
    throw new Error('INVALID_CHOICES');
  if (!original && item.displayAnswer !== undefined && !text(item.displayAnswer, 80))
    throw new Error('INVALID_QUESTION');
  if (
    item.traps !== undefined &&
    (!Array.isArray(item.traps) ||
      item.traps.length > 16 ||
      item.traps.some(
        (trap) =>
          !record(trap) ||
          !text(trap.answer, 80) ||
          typeof trap.reading !== 'string' ||
          readingIssues([trap.reading]).length,
      ))
  )
    throw new Error('INVALID_CHOICES');
  const letters = graphemes(answer);
  const distractors = item.distractors.map((candidate: unknown) => {
    if (
      typeof candidate !== 'string' ||
      candidate !== candidate.normalize('NFKC').trim() ||
      graphemes(candidate).length !== 1 ||
      !/^[ぁ-ゖー]+$/u.test(candidate)
    )
      throw new Error('INVALID_CHOICES');
    return candidate;
  });
  if (
    !/^[ぁ-ゖー]+$/u.test(answer) ||
    letters.length > 32 ||
    new Set(distractors).size !== distractors.length ||
    letters.some(
      (letter) =>
        distractors.filter((candidate) => candidate !== letter).length < choiceCount - 1,
    )
  )
    throw new Error('INVALID_CHOICES');
  return {
    id: item.id,
    version: 1,
    text: item.text as string,
    answer,
    ...(item.readings ? { readings: item.readings as string[] } : {}),
    ...(item.displayAnswer ? { displayAnswer: item.displayAnswer as string } : {}),
    ...(item.traps ? { traps: item.traps as { answer: string; reading: string }[] } : {}),
    ...(typeof item.categoryId === 'string' ? { categoryId: item.categoryId } : {}),
    ...(typeof item.difficulty === 'number' ? { difficulty: item.difficulty } : {}),
    ...(typeof item.seriesId === 'string' ? { seriesId: item.seriesId } : {}),
    ...(typeof item.generation === 'string' ? { generation: item.generation } : {}),
    explanation: item.explanation as string,
    distractors,
    source: item.source as string,
    permission: item.permission,
    demoAllowed: true,
  };
}
