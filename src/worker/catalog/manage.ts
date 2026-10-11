import { and, asc, eq, max, sql } from 'drizzle-orm';
import { changeD1, type Database, readD1, rowsD1 } from '../db/d1.ts';
import {
  questionAvailability as a,
  matchmakingSettings as active,
  questionSetItems as i,
  instances,
  questionVersions as q,
  rulesetVersions as r,
  questionSets as s,
} from '../db/schema.ts';
import { requireAdministrator } from '../organization/access.ts';
import { organizationIdentity } from '../organization/database.ts';
import { validateQuestion, validateRef } from './definition.ts';
import { contentHash } from './hash.ts';
import { validateCatalogOperation } from './operation.ts';
import { publishMatchConfig } from './publish.ts';

export { validateCatalogOperation } from './operation.ts';
export async function authorizeCatalog(db: Database, owner: string, subject: string) {
  const { organization, account } = await organizationIdentity(db, subject);
  requireAdministrator(account);
  const [scope] = await db
    .select()
    .from(instances)
    .where(
      and(eq(instances.owner, owner), eq(instances.organizationId, organization.id)),
    );
  if (!scope || scope.state === 'archived') throw new Error('CATALOG_FORBIDDEN');
}
export async function manageCatalog(
  db: Database,
  owner: string,
  input: unknown,
  subject: string,
) {
  const operation = validateCatalogOperation(input, owner);
  if (operation.operation === 'configure')
    return publishMatchConfig(db, operation.config, operation.profile, () =>
      authorizeCatalog(db, owner, subject),
    );
  return changeD1(db, async (writes) => {
    await authorizeCatalog(db, owner, subject);
    if (operation.operation === 'retire') {
      const scope = and(eq(a.owner, owner), eq(a.questionId, operation.questionId));
      const [original] = await db.select().from(a).where(scope);
      if (!original) throw new Error('QUESTION_NOT_FOUND');
      if (!original.retiredAt)
        writes.push(
          db.update(a).set({ retiredAt: new Date().toISOString() }).where(scope),
        );
      return { operation: operation.operation, questionId: operation.questionId };
    }
    if (operation.operation === 'set') {
      const rows = await db
        .select({ question: q.payload, retiredAt: a.retiredAt })
        .from(q)
        .innerJoin(a, and(eq(a.owner, q.owner), eq(a.questionId, q.questionId)))
        .where(
          and(
            eq(q.owner, owner),
            eq(q.version, 1),
            sql`${q.questionId} in (select value from json_each(${JSON.stringify(operation.questionIds)}))`,
          ),
        );
      if (
        rows.length !== operation.questionIds.length ||
        rows.some((row) => row.retiredAt !== null)
      )
        throw new Error('QUESTION_UNAVAILABLE');
      const byId = new Map(rows.map((row) => [row.question.id, row.question])),
        questions = operation.questionIds.map((id) => validateQuestion(byId.get(id), 2)),
        hash = await contentHash(questions),
        scope = and(eq(s.owner, owner), eq(s.setId, operation.setId));
      const [existing] = await db
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
      const [latest] = await db
          .select({ version: max(s.version) })
          .from(s)
          .where(scope),
        version = (latest.version ?? 0) + 1;
      writes.push(
        db
          .insert(s)
          .values({ owner, setId: operation.setId, version, manifestHash: hash }),
        rowsD1(
          i,
          questions.map((question, ordinal) => ({
            owner,
            setId: operation.setId,
            setVersion: version,
            ordinal: ordinal + 1,
            questionId: question.id,
            questionVersion: 1,
          })),
        ),
      );
      return { operation: operation.operation, setId: operation.setId, version };
    }
    const question = operation.question,
      [existing] = await db
        .select()
        .from(q)
        .where(and(eq(q.owner, owner), eq(q.questionId, question.id), eq(q.version, 1))),
      originalId = operation.operation === 'revise' ? operation.questionId : null;
    const [original] = originalId
      ? await db
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
    writes.push(
      db
        .insert(q)
        .values({ owner, questionId: question.id, version: 1, payload: question }),
      db.insert(a).values({ owner, questionId: question.id }),
    );
    if (originalId)
      writes.push(
        db
          .update(a)
          .set({ retiredAt: new Date().toISOString() })
          .where(and(eq(a.owner, owner), eq(a.questionId, originalId))),
      );
    return { operation: operation.operation, questionId: question.id };
  });
}
export async function listCatalog(db: Database, owner: string, subject: string) {
  validateRef({ owner, id: 'owner', version: 1 });
  return readD1(db, async () => {
    await authorizeCatalog(db, owner, subject);
    return {
      questions: await db
        .select({ questionId: a.questionId, retiredAt: a.retiredAt })
        .from(a)
        .where(eq(a.owner, owner))
        .orderBy(asc(a.questionId)),
      sets: await db
        .select()
        .from(s)
        .where(eq(s.owner, owner))
        .orderBy(asc(s.setId), asc(s.version)),
      rules: await db
        .select({ rulesetId: r.rulesetId, version: r.version, config: r.config })
        .from(r)
        .where(eq(r.owner, owner))
        .orderBy(asc(r.rulesetId), asc(r.version)),
      profiles: await db
        .select()
        .from(active)
        .where(eq(active.owner, owner))
        .orderBy(asc(active.profile)),
    };
  });
}
