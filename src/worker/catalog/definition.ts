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
  if (origin.protocol !== 'https:' || origin.origin !== value.owner)
    throw new Error('INVALID_VERSION');

  return { owner: value.owner, id: value.id, version: Number(value.version) };
}

export async function validateDefinition(value: unknown): Promise<MatchDefinition> {
  if (!record(value)) throw new Error('INVALID_DEFINITION');
  const competition = validateRef(value.competition);
  const ruleset = validateRef(value.ruleset);
  const questionSet = validateRef(value.questionSet);
  const rules = validateRules(value.rules);
  if (
    competition.owner !== ruleset.owner ||
    competition.owner !== questionSet.owner ||
    !Number.isInteger(value.playersPerMatch) ||
    Number(value.playersPerMatch) < 2 ||
    Number(value.playersPerMatch) > 4 ||
    !Array.isArray(value.questions) ||
    value.questions.length < 1 ||
    value.questions.length > 100
  )
    throw new Error('INVALID_DEFINITION');

  const ids = new Set<string>();
  const questions = value.questions.map((item: unknown): FixedQuestion => {
    if (
      !record(item) ||
      !text(item.id, 64) ||
      !/^[a-zA-Z0-9_-]+$/.test(item.id) ||
      ids.has(item.id) ||
      item.version !== 1 ||
      !text(item.text, 2000) ||
      !text(item.answer, 64) ||
      !text(item.explanation, 2000) ||
      !text(item.source, 1000) ||
      !text(item.permission, 1000) ||
      item.demoAllowed !== true ||
      !Array.isArray(item.distractors) ||
      item.distractors.length > 128
    )
      throw new Error('INVALID_QUESTION');
    ids.add(item.id);
    const answer = item.answer.normalize('NFKC').trim();
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
          distractors.filter((candidate) => candidate !== letter).length <
          rules.choiceCount - 1,
      )
    )
      throw new Error('INVALID_CHOICES');
    return {
      id: item.id,
      version: 1,
      text: item.text,
      answer,
      explanation: item.explanation,
      distractors,
      source: item.source,
      permission: item.permission,
      demoAllowed: true,
    };
  });

  if (
    value.rulesHash !== (await contentHash(rules)) ||
    value.manifestHash !== (await contentHash(questions))
  )
    throw new Error('DEFINITION_HASH_MISMATCH');

  return {
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
