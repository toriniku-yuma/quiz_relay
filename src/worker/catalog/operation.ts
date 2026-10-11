import { validateMatchConfig } from './config.ts';
import { type FixedQuestion, validateQuestion, validateRef } from './definition.ts';

type Operation =
  | { operation: 'register'; question: FixedQuestion }
  | { operation: 'revise'; questionId: string; question: FixedQuestion }
  | { operation: 'retire'; questionId: string }
  | { operation: 'set'; setId: string; questionIds: string[] }
  | {
      operation: 'configure';
      profile: string;
      config: ReturnType<typeof validateMatchConfig>;
    };

export function validateCatalogOperation(value: unknown, owner: string): Operation {
  validateRef({ owner, id: 'owner', version: 1 });
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('INVALID_OPERATION');
  const input = value as Record<string, unknown>;
  const keys: Record<string, string> = {
    register: 'operation,question',
    revise: 'operation,question,questionId',
    retire: 'operation,questionId',
    set: 'operation,questionIds,setId',
    configure: 'config,operation,profile',
  };
  if (
    typeof input.operation !== 'string' ||
    !Object.hasOwn(keys, input.operation) ||
    Object.keys(input).sort().join(',') !== keys[input.operation]
  )
    throw new Error('INVALID_OPERATION');
  const id = (value: unknown) => validateRef({ owner, id: value, version: 1 }).id;
  if (input.operation === 'configure') {
    const config = validateMatchConfig(input.config);
    if (config.owner !== owner) throw new Error('OWNER_MISMATCH');
    return { operation: 'configure', profile: id(input.profile), config };
  }
  if (input.operation === 'retire')
    return { operation: 'retire', questionId: id(input.questionId) };
  if (input.operation === 'set') {
    if (
      !Array.isArray(input.questionIds) ||
      input.questionIds.length < 1 ||
      input.questionIds.length > 100
    )
      throw new Error('INVALID_QUESTION_SET');
    const questionIds = input.questionIds.map(id);
    if (new Set(questionIds).size !== questionIds.length)
      throw new Error('INVALID_QUESTION_SET');
    return { operation: 'set', setId: id(input.setId), questionIds };
  }
  const question = validateQuestion(input.question, 2);
  if (
    Object.keys(input.question as object)
      .sort()
      .join(',') !==
    'answer,demoAllowed,distractors,explanation,id,permission,source,text,version'
  )
    throw new Error('INVALID_QUESTION');
  if (input.operation === 'register') return { operation: 'register', question };
  const questionId = id(input.questionId);
  if (questionId === question.id) throw new Error('REVISION_REQUIRES_NEW_ID');
  return { operation: 'revise', questionId, question };
}
