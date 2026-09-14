import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadMatchDefinition } from '../src/worker/catalog/database';
import {
  type MatchDefinition,
  validateDefinition,
} from '../src/worker/catalog/definition';
import { contentHash } from '../src/worker/catalog/hash';
import type { Env } from '../src/worker/env';
import { dummyCharacters } from '../src/worker/game/questions';
import { rules } from '../src/worker/game/rules';
import { adjudicate, createState, snapshot } from '../src/worker/game/state';
import { questionProvenance, questions } from './fixtures/questions';

const database = vi.hoisted(() => ({ query: vi.fn(), end: vi.fn() }));
vi.mock('../src/worker/db/connection.ts', () => ({
  connectDatabase: () => {
    const builder = {
      from: () => builder,
      innerJoin: () => builder,
      leftJoin: () => builder,
      where: () => builder,
      orderBy: () => database.query(),
    };
    return { db: { select: () => builder }, close: database.end };
  },
}));
beforeEach(() => {
  database.query.mockReset();
  database.end.mockReset().mockResolvedValue(undefined);
});

async function definition(): Promise<MatchDefinition> {
  const owner = 'https://example.com';
  const config = {
    ...rules,
    choiceCount: 6,
    characterAnswerTimeMs: 5000,
    showSelections: false,
  };
  const manifest = questions.map((question) => ({
    ...question,
    version: 1,
    distractors: [...dummyCharacters],
    ...questionProvenance,
  }));
  return validateDefinition({
    competition: { owner, id: 'demo', version: 1 },
    ruleset: { owner, id: 'standard', version: 2 },
    questionSet: { owner, id: 'mock', version: 1 },
    rulesHash: await contentHash(config),
    manifestHash: await contentHash(manifest),
    playersPerMatch: 3,
    rules: config,
    questions: manifest,
  });
}

describe('1C fixed catalog', () => {
  it('G14: fixed settings drive panels and deadlines without mutating older matches', async () => {
    const source = await definition();
    const previous = createState(questions, 0, 2);
    const state = createState(source.questions, 0, 3, true, source);
    source.rules.choiceCount = 2;
    source.questions[0].answer = 'あ';
    source.competition.version = 9;
    state.phase = 'REVEALING';
    state.deadline = 1000;
    state.players = ['a', 'b', 'c'].map((id) => ({
      id,
      name: id,
      correct: 0,
      mistakes: 0,
      locked: false,
      disqualified: false,
      connected: true,
    }));

    const reply = adjudicate(
      state,
      'a',
      {
        commandId: 'buzz',
        matchId: state.matchId,
        questionId: state.question.id,
        type: 'buzz',
        payload: {},
      },
      100,
    );

    expect(reply.ok).toBe(true);
    expect(state.panel?.choices).toHaveLength(6);
    expect(new Set(state.panel?.choices.map(({ text }) => text)).size).toBe(6);
    expect(state.panel?.deadline).toBe(5100);
    expect(state.question.answer).toBe('にじ');
    expect(state.definition?.competition.version).toBe(1);
    expect(previous.rules.choiceCount).toBe(4);
    expect(previous.rules.characterAnswerTimeMs).toBe(3000);
    expect(snapshot(state).showSelections).toBe(false);
    expect(snapshot(state)).not.toHaveProperty('definition');
    expect(snapshot(state)).not.toHaveProperty('questions');
    expect(JSON.stringify(snapshot(state))).not.toContain(state.question.answer);
  });

  it('G14: refuses insufficient/duplicate distractors and invalid rules before starting', async () => {
    const original = await definition();
    for (const distractors of [['あ'], ['あ', 'あ', 'い', 'う', 'え', 'お'], ['xx']]) {
      const changed = structuredClone(original);
      changed.questions[0].distractors = distractors;
      changed.manifestHash = await contentHash(changed.questions);
      await expect(validateDefinition(changed)).rejects.toThrow('INVALID_CHOICES');
    }
    for (const choiceCount of [0, 1, 9, 2.5, Infinity]) {
      await expect(
        validateDefinition({ ...original, rules: { ...original.rules, choiceCount } }),
      ).rejects.toThrow('INVALID_RULES');
    }
    await expect(
      validateDefinition({
        ...original,
        rules: { ...original.rules, characterAnswerTimeMs: 0 },
      }),
    ).rejects.toThrow('INVALID_RULES');
  });

  it('refuses hash mismatch, duplicate question IDs and inconsistent version references', async () => {
    const original = await definition();
    const changed = structuredClone(original);
    changed.questions[0].text += 'changed';
    await expect(validateDefinition(changed)).rejects.toThrow('DEFINITION_HASH_MISMATCH');
    changed.questions[1].id = changed.questions[0].id;
    await expect(validateDefinition(changed)).rejects.toThrow('INVALID_QUESTION');
    await expect(
      validateDefinition({
        ...original,
        ruleset: { ...original.ruleset, owner: 'https://other.example.com' },
      }),
    ).rejects.toThrow('INVALID_DEFINITION');
    await expect(
      validateDefinition({
        ...original,
        competition: { ...original.competition, version: 0 },
      }),
    ).rejects.toThrow('INVALID_VERSION');
    expect(() => createState(original.questions, 0, 2, true, original)).toThrow(
      'INVALID_SETUP',
    );
    expect(() => createState(original.questions, 1, 3, true, original)).toThrow(
      'INVALID_SETUP',
    );
  });

  it('fails closed without a game DB instead of using probe credentials or bundled mocks', async () => {
    await expect(
      loadMatchDefinition({ DATABASE_URL: 'must-not-use' } as Env, {
        owner: 'https://example.com',
        id: 'demo',
        version: 1,
      }),
    ).rejects.toThrow('GAME_DATABASE_NOT_CONFIGURED');
  });
});

it('DB loader rejects absent/retired data and closes connections on every failure', async () => {
  const source = await definition();
  const rows = source.questions.map((question) => ({
    competition: {
      owner: source.competition.owner,
      competitionId: source.competition.id,
      version: source.competition.version,
      playersPerMatch: source.playersPerMatch,
    },
    ruleset: {
      owner: source.ruleset.owner,
      rulesetId: source.ruleset.id,
      version: source.ruleset.version,
      rulesHash: source.rulesHash,
      config: source.rules,
    },
    questionSet: {
      owner: source.questionSet.owner,
      setId: source.questionSet.id,
      version: source.questionSet.version,
      manifestHash: source.manifestHash,
    },
    question,
    availability: {
      owner: source.competition.owner,
      questionId: question.id,
      retiredAt: null,
    },
  }));
  const env = { GAME_DATABASE_URL: 'postgres://test-only' } as Env;
  database.query.mockResolvedValueOnce(rows);
  expect(await loadMatchDefinition(env, source.competition)).toEqual(source);
  expect(database.end).toHaveBeenCalledTimes(1);

  database.query.mockResolvedValueOnce([]);
  await expect(loadMatchDefinition(env, source.competition)).rejects.toThrow(
    'DEFINITION_NOT_FOUND',
  );
  database.query.mockResolvedValueOnce(
    rows.map((row) => ({ ...row, availability: null })),
  );
  await expect(loadMatchDefinition(env, source.competition)).rejects.toThrow(
    'QUESTION_UNAVAILABLE',
  );
  database.query.mockResolvedValueOnce(
    rows.map((row) => ({ ...row, ruleset: { ...row.ruleset, rulesHash: 'mismatch' } })),
  );
  await expect(loadMatchDefinition(env, source.competition)).rejects.toThrow(
    'DEFINITION_HASH_MISMATCH',
  );
  database.query.mockRejectedValueOnce(new Error('database offline'));
  await expect(loadMatchDefinition(env, source.competition)).rejects.toThrow(
    'database offline',
  );
  expect(database.end).toHaveBeenCalledTimes(5);
  database.query.mockResolvedValueOnce(rows);
  expect(
    await loadMatchDefinition({
      ...env,
      GAME_OWNER: source.competition.owner,
      GAME_CONFIG_PROFILE: 'local',
    }),
  ).toEqual(source);
  database.query.mockResolvedValueOnce(
    rows.map((row) => ({
      ...row,
      competition: { ...row.competition, version: 2, playersPerMatch: 2 },
    })),
  );
  const next = await loadMatchDefinition({
    ...env,
    GAME_OWNER: source.competition.owner,
    GAME_CONFIG_PROFILE: 'local',
  });
  expect(next.competition.version).toBe(2);
  expect(next.playersPerMatch).toBe(2);
});

it('requires an explicit non-empty question set to create a match', () => {
  expect(() => createState([], 0, 2)).toThrow('INVALID_SETUP');
});
