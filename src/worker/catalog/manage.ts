import { and, asc, eq, inArray, isNull, max, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import {
  questionAvailability as a,
  matchmakingSettings as active,
  catalogOperators,
  questionSetItems as i,
  questionVersions as q,
  rulesetVersions as r,
  questionSets as s,
} from '../db/schema.ts';
import { validateMatchConfig } from './config.ts';
import { type FixedQuestion, validateQuestion, validateRef } from './definition.ts';
import { contentHash } from './hash.ts';
import { publishMatchConfig } from './publish.ts';

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

export async function authorizeCatalog(db: PostgresJsDatabase, owner: string) {
  const [operator] = await db
    .select({ owner: catalogOperators.owner })
    .from(catalogOperators)
    .where(
      and(
        eq(catalogOperators.roleName, sql`current_user`),
        eq(catalogOperators.owner, owner),
      ),
    );
  if (!operator) throw new Error('CATALOG_FORBIDDEN');
}

export async function manageCatalog(
  db: PostgresJsDatabase,
  owner: string,
  input: unknown,
) {
  const operation = validateCatalogOperation(input, owner);
  await authorizeCatalog(db, owner);
  if (operation.operation === 'configure')
    return publishMatchConfig(db, operation.config, operation.profile);

  return db.transaction(async (tx) => {
    // 設定反映と同じ開催元ロックで、改訂・停止・セット作成を直列化する。
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${owner}, 0))`);
    if (operation.operation === 'retire') {
      const scope = and(eq(a.owner, owner), eq(a.questionId, operation.questionId));
      const [original] = await tx.select().from(a).where(scope);
      if (!original) throw new Error('QUESTION_NOT_FOUND');
      if (!original.retiredAt)
        await tx.update(a).set({ retiredAt: new Date().toISOString() }).where(scope);
      return { operation: operation.operation, questionId: operation.questionId };
    }
    if (operation.operation === 'set') {
      const rows = await tx
        .select({ question: q.payload, retiredAt: a.retiredAt })
        .from(q)
        .innerJoin(a, and(eq(a.owner, q.owner), eq(a.questionId, q.questionId)))
        .where(
          and(
            eq(q.owner, owner),
            eq(q.version, 1),
            inArray(q.questionId, operation.questionIds),
          ),
        );
      if (
        rows.length !== operation.questionIds.length ||
        rows.some((row) => row.retiredAt !== null)
      )
        throw new Error('QUESTION_UNAVAILABLE');
      const byId = new Map(rows.map((row) => [row.question.id, row.question]));
      const questions = operation.questionIds.map((id) =>
        validateQuestion(byId.get(id), 2),
      );
      const hash = await contentHash(questions);
      const scope = and(eq(s.owner, owner), eq(s.setId, operation.setId));
      const [existing] = await tx
        .select()
        .from(s)
        .where(and(scope, eq(s.manifestHash, hash)))
        .orderBy(asc(s.version))
        .limit(1);
      if (existing)
        return {
          operation: operation.operation,
          setId: operation.setId,
          version: existing.version,
        };
      const [latest] = await tx
        .select({ version: max(s.version) })
        .from(s)
        .where(scope);
      const version = (latest.version ?? 0) + 1;
      await tx
        .insert(s)
        .values({ owner, setId: operation.setId, version, manifestHash: hash });
      await tx.insert(i).values(
        questions.map((question, ordinal) => ({
          owner,
          setId: operation.setId,
          setVersion: version,
          ordinal: ordinal + 1,
          questionId: question.id,
          questionVersion: 1,
        })),
      );
      return { operation: operation.operation, setId: operation.setId, version };
    }
    const question = operation.question;
    const [existing] = await tx
      .select()
      .from(q)
      .where(and(eq(q.owner, owner), eq(q.questionId, question.id), eq(q.version, 1)));
    const originalId = operation.operation === 'revise' ? operation.questionId : null;
    const [original] = originalId
      ? await tx
          .select()
          .from(a)
          .where(and(eq(a.owner, owner), eq(a.questionId, originalId)))
      : [];
    if (originalId && !original) throw new Error('QUESTION_NOT_FOUND');
    if (existing) {
      if (
        (await contentHash(existing.payload)) !== (await contentHash(question)) ||
        (original && !original.retiredAt)
      )
        throw new Error('QUESTION_ID_CONFLICT');
      return { operation: operation.operation, questionId: question.id };
    }
    if (original?.retiredAt) throw new Error('QUESTION_UNAVAILABLE');
    await tx
      .insert(q)
      .values({ owner, questionId: question.id, version: 1, payload: question });
    await tx.insert(a).values({ owner, questionId: question.id });
    if (originalId)
      await tx
        .update(a)
        .set({ retiredAt: new Date().toISOString() })
        .where(
          and(eq(a.owner, owner), eq(a.questionId, originalId), isNull(a.retiredAt)),
        );
    return { operation: operation.operation, questionId: question.id };
  });
}

export async function listCatalog(db: PostgresJsDatabase, owner: string) {
  validateRef({ owner, id: 'owner', version: 1 });
  await authorizeCatalog(db, owner);
  return db.transaction(
    async (tx) => ({
      questions: await tx
        .select({ questionId: a.questionId, retiredAt: a.retiredAt })
        .from(a)
        .where(eq(a.owner, owner))
        .orderBy(asc(a.questionId)),
      sets: await tx
        .select()
        .from(s)
        .where(eq(s.owner, owner))
        .orderBy(asc(s.setId), asc(s.version)),
      rules: await tx
        .select({ rulesetId: r.rulesetId, version: r.version, config: r.config })
        .from(r)
        .where(eq(r.owner, owner))
        .orderBy(asc(r.rulesetId), asc(r.version)),
      profiles: await tx
        .select()
        .from(active)
        .where(eq(active.owner, owner))
        .orderBy(asc(active.profile)),
    }),
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
}
