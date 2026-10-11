import { and, eq, isNull, sql } from 'drizzle-orm';
import { exportJWK, exportSPKI, importJWK, importPKCS8 } from 'jose';
import {
  disabledFederationPermissions,
  FEDERATION_FRESH_MS,
} from '../../shared/federation.ts';
import type {
  QuestionImportConfig,
  QuestionSharingOverview,
} from '../../shared/federation-questions.ts';
import { changeD1, readD1, rowsD1 } from '../db/d1.ts';
import {
  federationMetadata,
  federationPeers,
  federationPolicies,
  federationQuestionImports,
  federationQuestionLinks,
  federationQuestionSources,
  instances,
  questionCategories,
} from '../db/schema.ts';
import type { Env } from '../env.ts';
import {
  OrganizationError,
  requireAdministrator,
  validId,
  validName,
} from '../organization/access.ts';
import { resolveInstance } from '../organization/database.ts';
import { questionContext } from '../questions/read.ts';
import { peerRequest } from './egress.ts';
import { cachedQuestionSource } from './question-sources.ts';
import { INBOX_PATH } from './signatures.ts';
import { federationDatabase } from './transport.ts';

function exact(input: Record<string, unknown>, fields: string[]) {
  if (Object.keys(input).some((key) => !fields.includes(key)))
    throw new OrganizationError('INVALID_QUESTION_SHARING', 400);
}
function revision(value: unknown) {
  if (!Number.isSafeInteger(value) || Number(value) < 0)
    throw new OrganizationError('INVALID_REVISION', 400);
  return Number(value);
}
function importConfiguration(value: unknown): QuestionImportConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new OrganizationError('INVALID_QUESTION_IMPORT', 400);
  const config = value as QuestionImportConfig;
  if (
    Object.keys(config).sort().join(',') !==
      'categories,difficulty,fallback,targetCategoryId' ||
    !Array.isArray(config.categories) ||
    config.categories.length > 100 ||
    !config.difficulty ||
    typeof config.difficulty !== 'object' ||
    Array.isArray(config.difficulty) ||
    Object.entries(config.difficulty).some(
      ([key, level]) => !/^[0-9]{1,3}$/.test(key) || ![0, 1, 2].includes(level),
    ) ||
    ![0, 1, 2].includes(config.fallback)
  )
    throw new OrganizationError('INVALID_QUESTION_IMPORT', 400);
  for (const id of config.categories) validId(id);
  if (new Set(config.categories).size !== config.categories.length)
    throw new OrganizationError('INVALID_QUESTION_IMPORT', 400);
  validId(config.targetCategoryId);
  return {
    ...structuredClone(config),
    difficulty: { '0': 0, '1': 1, '2': 2 },
    fallback: 0,
  };
}
export async function questionSharing(
  env: Env,
  subject: string,
  input: Record<string, unknown>,
) {
  const db = federationDatabase(env),
    instanceId = validId(input.instanceId),
    ctx = await questionContext(db, subject, instanceId);
  if (!ctx.review) throw new OrganizationError('REVIEW_FORBIDDEN', 403);
  if (input.operation === 'source') {
    exact(input, ['operation', 'instanceId', 'peerOrigin', 'sourceInstanceId']);
    return cachedQuestionSource(db, {
      instanceId,
      peerOrigin: String(input.peerOrigin ?? ''),
      sourceInstanceId: validId(input.sourceInstanceId),
    });
  }
  if (input.operation === 'overview') {
    exact(input, ['operation', 'instanceId']);
    return readD1(db, async (): Promise<QuestionSharingOverview> => {
      const categories = await db
        .select()
        .from(questionCategories)
        .where(
          and(
            eq(questionCategories.instanceId, instanceId),
            eq(questionCategories.active, true),
          ),
        )
        .orderBy(questionCategories.name);
      const imports = await db
        .select({
          id: federationQuestionImports.id,
          peerOrigin: federationQuestionImports.peerOrigin,
          sourceInstanceId: federationQuestionImports.sourceInstanceId,
          config: federationQuestionImports.config,
          revision: federationQuestionImports.revision,
          enabled: federationQuestionImports.enabled,
          syncing:
            sql<number>`${federationQuestionImports.activeSnapshot} is null or ${federationQuestionImports.cursor} is not null`.mapWith(
              Boolean,
            ),
          lastSuccessAt: federationQuestionImports.lastSuccessAt,
          nextAttemptAt: federationQuestionImports.nextAttemptAt,
          errorCode: federationQuestionImports.errorCode,
        })
        .from(federationQuestionImports)
        .where(eq(federationQuestionImports.instanceId, instanceId));
      const sourceCategories = new Map<
        string,
        QuestionSharingOverview['sourceCategories'][number]
      >();
      const remembered = (
        await db
          .select({
            peerOrigin: federationQuestionLinks.peerOrigin,
            sourceInstanceId: federationQuestionLinks.sourceInstanceId,
            category: federationQuestionLinks.sourceCategory,
          })
          .from(federationQuestionLinks)
          .where(eq(federationQuestionLinks.instanceId, instanceId))
          .groupBy(
            federationQuestionLinks.peerOrigin,
            federationQuestionLinks.sourceInstanceId,
            federationQuestionLinks.sourceCategory,
          )
      ).map((row) => ({
        peerOrigin: row.peerOrigin,
        sourceInstanceId: row.sourceInstanceId,
        ...row.category,
      }));
      const cached = await db
        .select()
        .from(federationQuestionSources)
        .where(eq(federationQuestionSources.instanceId, instanceId));
      for (const category of [
        ...remembered,
        ...cached.flatMap((source) =>
          source.categories.map((category) => ({
            peerOrigin: source.peerOrigin,
            sourceInstanceId: source.sourceInstanceId,
            ...category,
          })),
        ),
      ])
        sourceCategories.set(
          `${category.peerOrigin}|${category.sourceInstanceId}|${category.id}`,
          category,
        );
      return {
        administrator: ctx.account.administrator,
        sourceCategories: [...sourceCategories.values()],
        sources: [
          ...(env.FEDERATION_ORIGIN
            ? (
                await db
                  .select()
                  .from(instances)
                  .where(
                    and(
                      eq(instances.organizationId, ctx.organization.id),
                      eq(instances.state, 'published'),
                      sql`${instances.id}<>${instanceId}`,
                    ),
                  )
              ).map((instance) => ({
                peerOrigin: env.FEDERATION_ORIGIN ?? '',
                instanceId: instance.id,
                name: `この組織 ／ ${instance.name}`,
                internal: true,
              }))
            : []),
          ...(
            await db
              .select({ metadata: federationMetadata, peer: federationPeers })
              .from(federationMetadata)
              .innerJoin(
                federationPeers,
                eq(federationPeers.origin, federationMetadata.peerOrigin),
              )
              .where(
                and(
                  eq(federationMetadata.instanceId, instanceId),
                  eq(federationPeers.approved, true),
                  isNull(federationMetadata.errorCode),
                ),
              )
          ).flatMap(({ metadata, peer }) =>
            metadata.lastSuccessAt > Date.now() - FEDERATION_FRESH_MS
              ? metadata.payload.instances.map((instance) => ({
                  peerOrigin: peer.origin,
                  instanceId: instance.id,
                  name: `${metadata.payload.organization.name} ／ ${instance.name}`,
                  internal: false,
                }))
              : [],
          ),
        ],
        categories: categories.map((category) => ({
          id: category.id,
          name: category.name,
          importOnly: category.importOnly,
          revision: category.revision,
        })),
        imports,
      };
    });
  }
  return changeD1(db, async (writes) => {
    const currentContext = await questionContext(db, subject, instanceId);
    if (!currentContext.review || currentContext.instance.state === 'archived')
      throw new OrganizationError('REVIEW_FORBIDDEN', 403);
    if (input.operation === 'internalPermission') {
      exact(input, ['operation', 'instanceId', 'sourceInstanceId', 'allowed']);
      requireAdministrator(currentContext.account);
      const sourceInstanceId = validId(input.sourceInstanceId);
      await resolveInstance(db, subject, sourceInstanceId, true);
      if (
        sourceInstanceId === instanceId ||
        typeof input.allowed !== 'boolean' ||
        !env.FEDERATION_ORIGIN
      )
        throw new OrganizationError('INVALID_QUESTION_SHARING', 400);
      const peerOrigin = env.FEDERATION_ORIGIN;
      const [peer] = await db
        .select()
        .from(federationPeers)
        .where(eq(federationPeers.origin, peerOrigin));
      if (!peer) {
        const { d: _privateComponent, ...publicJwk } = await exportJWK(
          await importPKCS8(env.SIGNING_PRIVATE_KEY ?? '', 'EdDSA', {
            extractable: true,
          }),
        );
        const publicKey = await exportSPKI(
          (await importJWK(publicJwk, 'EdDSA')) as CryptoKey,
        );
        writes.push(
          db.insert(federationPeers).values({
            origin: peerOrigin,
            name: currentContext.organization.name,
            kid: env.SIGNING_KID ?? '',
            publicKey,
            approved: true,
          }),
        );
      }
      const policies = await db
        .select()
        .from(federationPolicies)
        .where(
          and(
            eq(federationPolicies.peerOrigin, peerOrigin),
            sql`(${federationPolicies.instanceId},${federationPolicies.peerInstanceId}) in ((${sourceInstanceId},${instanceId}),(${instanceId},${sourceInstanceId}))`,
          ),
        );
      const rows = [
        [sourceInstanceId, instanceId, 'send'],
        [instanceId, sourceInstanceId, 'receive'],
      ] as const;
      for (const [local, remote, direction] of rows) {
        const before = policies.find(
            (policy) => policy.instanceId === local && policy.peerInstanceId === remote,
          ),
          permissions = structuredClone(
            before?.permissions ?? disabledFederationPermissions(),
          );
        permissions[direction].questions = input.allowed;
        writes.push(
          rowsD1(
            federationPolicies,
            [
              {
                id: before?.id ?? crypto.randomUUID(),
                instanceId: local,
                peerInstanceId: remote,
                peerOrigin,
                permissions,
                revision: (before?.revision ?? 0) + 1,
              },
            ],
            true,
          ),
        );
      }
      return { ok: true };
    }
    if (input.operation === 'import') {
      exact(input, [
        'operation',
        'instanceId',
        'id',
        'revision',
        'peerOrigin',
        'sourceInstanceId',
        'config',
        'enabled',
        'newCategoryName',
        'newCategoryImportOnly',
      ]);
      const id = validId(input.id),
        sourceInstanceId = validId(input.sourceInstanceId),
        expected = revision(input.revision),
        peerOrigin = String(input.peerOrigin ?? '');
      if (
        typeof input.enabled !== 'boolean' ||
        (peerOrigin === env.FEDERATION_ORIGIN && sourceInstanceId === instanceId)
      )
        throw new OrganizationError('INVALID_QUESTION_IMPORT', 400);
      if (peerOrigin !== env.FEDERATION_ORIGIN)
        peerRequest(peerOrigin, [peerOrigin], INBOX_PATH, 'validation');
      const config = importConfiguration(input.config);
      const [before] = await db
        .select()
        .from(federationQuestionImports)
        .where(eq(federationQuestionImports.id, id));
      if (
        (before?.revision ?? 0) !== expected ||
        (before &&
          (before.instanceId !== instanceId ||
            before.peerOrigin !== peerOrigin ||
            before.sourceInstanceId !== sourceInstanceId))
      )
        throw new OrganizationError('QUESTION_IMPORT_CONFLICT', 409);
      const categories = await db
        .select()
        .from(questionCategories)
        .where(eq(questionCategories.instanceId, instanceId));
      if (input.newCategoryName !== undefined) {
        requireAdministrator(currentContext.account);
        const name = validName(input.newCategoryName);
        if (
          input.newCategoryImportOnly !== undefined &&
          typeof input.newCategoryImportOnly !== 'boolean'
        )
          throw new OrganizationError('INVALID_QUESTION_IMPORT', 400);
        if (
          categories.some(
            (category) =>
              category.id === config.targetCategoryId || category.name === name,
          )
        )
          throw new OrganizationError('CATEGORY_CONFLICT', 409);
        writes.push(
          db.insert(questionCategories).values({
            id: config.targetCategoryId,
            instanceId,
            name,
            importOnly: input.newCategoryImportOnly === true,
          }),
        );
      } else if (
        !categories.some(
          (category) => category.id === config.targetCategoryId && category.active,
        )
      )
        throw new OrganizationError('CATEGORY_REQUIRED', 400);
      const imports = await db
        .select()
        .from(federationQuestionImports)
        .where(
          and(
            eq(federationQuestionImports.instanceId, instanceId),
            eq(federationQuestionImports.peerOrigin, peerOrigin),
            eq(federationQuestionImports.sourceInstanceId, sourceInstanceId),
          ),
        );
      const overlap = imports.find(
        (row) =>
          row.id !== id &&
          (!row.config.categories.length ||
            !config.categories.length ||
            row.config.categories.some((category) =>
              config.categories.includes(category),
            )),
      );
      if (overlap) throw new OrganizationError('QUESTION_IMPORT_OVERLAP', 409);
      writes.push(
        rowsD1(
          federationQuestionImports,
          [
            {
              id,
              instanceId,
              peerOrigin,
              sourceInstanceId,
              config,
              enabled: input.enabled,
              revision: expected + 1,
              snapshot: null,
              cursor: null,
              activeSnapshot: null,
              errorCode: null,
              nextAttemptAt: 0,
              attemptId: null,
              leaseUntil: 0,
              ...(!before ? { lastSuccessAt: 0 } : {}),
            },
          ],
          true,
        ),
      );
      return { ok: true, id };
    }
    throw new OrganizationError('INVALID_QUESTION_SHARING', 400);
  });
}
