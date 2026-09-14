import { validateRules } from '../game/rules.ts';
import { validateRef } from './definition.ts';

export function validateMatchConfig(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('INVALID_MATCHMAKING_CONFIG');
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).sort().join(',') !==
      'competitionId,owner,playersPerMatch,questionSet,rules,rulesetId' ||
    !Number.isInteger(input.playersPerMatch) ||
    Number(input.playersPerMatch) < 2 ||
    Number(input.playersPerMatch) > 4 ||
    !input.questionSet ||
    typeof input.questionSet !== 'object' ||
    Array.isArray(input.questionSet) ||
    Object.keys(input.questionSet).sort().join(',') !== 'id,version'
  )
    throw new Error('INVALID_MATCHMAKING_CONFIG');
  const competition = validateRef({
    owner: input.owner,
    id: input.competitionId,
    version: 1,
  });
  const ruleset = validateRef({ owner: input.owner, id: input.rulesetId, version: 1 });
  const questionSet = validateRef({ owner: input.owner, ...input.questionSet });
  return {
    owner: competition.owner,
    competitionId: competition.id,
    rulesetId: ruleset.id,
    questionSet: { id: questionSet.id, version: questionSet.version },
    playersPerMatch: Number(input.playersPerMatch),
    rules: validateRules(input.rules),
  };
}
