import { and, eq, sql } from 'drizzle-orm';
import {
  normalizeTag,
  type QuestionInput,
  validateQuestionInput,
} from '../../shared/questions.ts';
import { contentHash } from '../catalog/hash.ts';
import { type D1Write, type Database, rowBatchesD1 } from '../db/d1.ts';
import {
  questionAuthors,
  questionAvailability,
  questionCategories,
  questionDifficulty,
  questionNotifications,
  questionSettings,
  questionSubmissionEvents,
  questionSubmissions,
  questionTags,
  questionVersions,
} from '../db/schema.ts';
import type { Question } from '../game/questions.ts';
import { dummyCharacters } from '../game/questions.ts';
import { QuestionError } from './error.ts';
import { questionSearchText } from './search.ts';

// Question-domain rows only. Reads stay native; this never emulates a DB transaction.
export class QuestionPlan {
  readonly submissions = new Map<string, typeof questionSubmissions.$inferSelect>();
  readonly categories = new Map<string, typeof questionCategories.$inferSelect>();
  readonly authors = new Map<string, typeof questionAuthors.$inferSelect>();
  readonly tags = new Map<string, typeof questionTags.$inferSelect>();
  readonly difficulty = new Map<string, typeof questionDifficulty.$inferSelect>();
  readonly versions = new Map<string, typeof questionVersions.$inferSelect>();
  readonly changedSubmissions = new Map<
    string,
    typeof questionSubmissions.$inferSelect
  >();
  readonly changedCategories = new Map<string, typeof questionCategories.$inferSelect>();
  readonly changedAuthors = new Map<string, typeof questionAuthors.$inferSelect>();
  readonly changedTags = new Map<string, typeof questionTags.$inferSelect>();
  readonly changedDifficulty = new Map<string, typeof questionDifficulty.$inferSelect>();
  readonly newVersions: (typeof questionVersions.$inferInsert)[] = [];
  readonly availability = new Map<string, typeof questionAvailability.$inferInsert>();
  readonly events: (typeof questionSubmissionEvents.$inferInsert)[] = [];
  readonly notifications: (typeof questionNotifications.$inferInsert)[] = [];
  configuration?: typeof questionSettings.$inferSelect;
  catalogChanged = false;

  readonly instanceId: string;
  readonly owner: string;
  constructor(instanceId: string, owner: string) {
    this.instanceId = instanceId;
    this.owner = owner;
  }

  async load(db: Database, input: Record<string, unknown>) {
    const broad = [
      'category',
      'merge-tags',
      'settings',
      'author-decision',
      'export',
      'export-managed',
    ].includes(String(input.operation));
    const ids = new Set<string>();
    if (typeof input.id === 'string') ids.add(input.id);
    for (const list of [input.changes, input.ids]) {
      if (Array.isArray(list))
        for (const item of list) {
          if (typeof item === 'string') ids.add(item);
          else if (item && typeof item === 'object' && typeof item.id === 'string')
            ids.add(item.id);
        }
    }
    const submissions =
      broad || ids.size
        ? await db
            .select()
            .from(questionSubmissions)
            .where(
              and(
                eq(questionSubmissions.instanceId, this.instanceId),
                broad
                  ? undefined
                  : sql`${questionSubmissions.id} in (select value from json_each(${JSON.stringify([...ids])}))`,
              ),
            )
        : [];
    for (const row of submissions) this.submissions.set(row.id, row);
    for (const row of await db
      .select()
      .from(questionCategories)
      .where(eq(questionCategories.instanceId, this.instanceId)))
      this.categories.set(row.id, row);
    for (const row of await db
      .select()
      .from(questionTags)
      .where(eq(questionTags.instanceId, this.instanceId)))
      this.tags.set(row.key, row);
    for (const row of await db
      .select()
      .from(questionAuthors)
      .where(eq(questionAuthors.instanceId, this.instanceId)))
      this.authors.set(row.actorId, row);
    if (submissions.length) {
      const series = JSON.stringify(submissions.map((row) => row.seriesId));
      for (const row of await db
        .select()
        .from(questionDifficulty)
        .where(
          and(
            eq(questionDifficulty.instanceId, this.instanceId),
            sql`${questionDifficulty.seriesId} in (select value from json_each(${series}))`,
          ),
        ))
        this.difficulty.set(row.seriesId, row);
      const published = JSON.stringify(
        submissions.flatMap((row) => (row.publishedId ? [row.publishedId] : [])),
      );
      for (const row of await db
        .select()
        .from(questionVersions)
        .where(
          and(
            eq(questionVersions.owner, this.owner),
            sql`${questionVersions.questionId} in (select value from json_each(${published}))`,
          ),
        ))
        this.versions.set(row.questionId, row);
    }
  }

  checkedInput(input: unknown, submitting: boolean): QuestionInput {
    const parsed = validateQuestionInput(input, submitting);
    if (parsed.issues.length)
      throw new QuestionError('INVALID_QUESTION', 400, parsed.issues);
    if (submitting && !this.categories.get(parsed.value.categoryId)?.active)
      throw new QuestionError('CATEGORY_REQUIRED', 400);
    if (this.categories.get(parsed.value.categoryId)?.importOnly)
      throw new QuestionError('CATEGORY_IMPORT_ONLY', 403);
    for (const name of parsed.value.tags) {
      const key = normalizeTag(name);
      if (!this.tags.has(key)) {
        const row = { instanceId: this.instanceId, key, name, aliases: [] };
        this.tags.set(key, row);
        this.changedTags.set(key, row);
      }
    }
    return {
      ...parsed.value,
      tags: [
        ...new Set(
          parsed.value.tags.map(
            (name) => this.tags.get(normalizeTag(name))?.name ?? name,
          ),
        ),
      ],
    };
  }

  save(
    row: typeof questionSubmissions.$inferSelect,
    patch: Partial<typeof questionSubmissions.$inferSelect>,
  ) {
    const updated = { ...row, ...patch };
    updated.searchText = questionSearchText(updated.input);
    this.submissions.set(updated.id, updated);
    this.changedSubmissions.set(updated.id, updated);
    return updated;
  }

  draft(
    actorId: string,
    authorName: string,
    input: QuestionInput,
    extra: Partial<typeof questionSubmissions.$inferSelect> = {},
  ) {
    const id = crypto.randomUUID();
    return this.save(
      {
        id,
        instanceId: this.instanceId,
        seriesId: id,
        authorId: actorId,
        authorName,
        input,
        searchText: questionSearchText(input),
        provenance: null,
        deletedAt: null,
        reviewHold: false,
        revision: 1,
        status: 'draft',
        reason: '',
        publishedId: null,
        stopped: false,
        updatedAt: new Date().toISOString(),
        ...extra,
      },
      {},
    );
  }

  audit(row: typeof questionSubmissions.$inferSelect, actorId: string, action: string) {
    this.events.push({
      id: crypto.randomUUID(),
      instanceId: this.instanceId,
      submissionId: row.id,
      revision: row.revision,
      actorId,
      action,
      input: row.input,
      reason: row.reason,
    });
  }

  notify(
    actorId: string,
    message: string,
    target: { page: 'edit' | 'qualification'; id?: string },
  ) {
    this.notifications.push({
      id: crypto.randomUUID(),
      instanceId: this.instanceId,
      actorId,
      message,
      target,
    });
  }

  retire(id: string, retiredAt: string | null) {
    this.availability.set(id, { owner: this.owner, questionId: id, retiredAt });
    this.catalogChanged = true;
  }

  metadata(
    row: typeof questionSubmissions.$inferSelect,
    change: { categoryId?: string; difficulty?: number },
  ) {
    if (!row.publishedId) return row;
    const old = this.versions.get(row.publishedId);
    if (!old) throw new Error('PUBLISHED_QUESTION_NOT_FOUND');
    const id = crypto.randomUUID();
    const version: typeof questionVersions.$inferSelect = {
      owner: this.owner,
      questionId: id,
      version: 1,
      payload: { ...old.payload, ...change, id },
    };
    this.versions.set(id, version);
    this.newVersions.push(version);
    this.retire(
      id,
      row.stopped || row.reviewHold || row.deletedAt ? new Date().toISOString() : null,
    );
    this.retire(old.questionId, new Date().toISOString());
    return this.save(row, { publishedId: id });
  }

  async publish(
    row: typeof questionSubmissions.$inferSelect,
    sharedSource?: Question['sharedSource'],
  ) {
    const id = crypto.randomUUID();
    const previous = row.publishedId ? this.versions.get(row.publishedId) : undefined;
    const core = (value: {
      text: string;
      displayAnswer?: string;
      readings?: string[];
      traps?: { answer: string; reading: string }[];
    }) => ({
      text: value.text,
      displayAnswer: value.displayAnswer,
      readings: value.readings,
      traps: value.traps ?? [],
    });
    const generation =
      previous &&
      (await contentHash(core(previous.payload))) === (await contentHash(core(row.input)))
        ? (previous.payload.generation ?? id)
        : id;
    const current = this.difficulty.get(row.seriesId);
    const effective =
      current?.fixed || current?.generation === generation
        ? current.current
        : row.input.difficulty;
    const difficulty = {
      instanceId: this.instanceId,
      seriesId: row.seriesId,
      generation,
      current: effective,
      fixed: current?.fixed ?? false,
      revision: (current?.revision ?? 0) + 1,
      stats: current?.generation === generation ? current.stats : [],
      lastDay: current?.generation === generation ? current.lastDay : null,
      statisticsRevision:
        current?.generation === generation ? current.statisticsRevision : 0,
      cursor: current?.generation === generation ? current.cursor : null,
      reason:
        current?.generation === generation
          ? current.reason
          : '改訂により集計を開始しました。',
    };
    this.difficulty.set(row.seriesId, difficulty);
    this.changedDifficulty.set(row.seriesId, difficulty);
    const version: typeof questionVersions.$inferSelect = {
      owner: this.owner,
      questionId: id,
      version: 1,
      payload: {
        id,
        version: 1,
        text: row.input.text,
        answer: row.input.readings[0],
        readings: row.input.readings,
        displayAnswer: row.input.displayAnswer,
        explanation: row.input.explanation,
        source: row.input.source || '投稿問題',
        permission: 'instance',
        demoAllowed: true,
        distractors: dummyCharacters,
        traps: row.input.traps,
        categoryId: row.input.categoryId,
        difficulty: effective,
        seriesId: row.seriesId,
        generation,
        ...(sharedSource ? { sharedSource } : {}),
      },
    };
    this.versions.set(id, version);
    this.newVersions.push(version);
    this.retire(
      id,
      row.stopped || row.reviewHold || row.deletedAt ? new Date().toISOString() : null,
    );
    if (row.publishedId) this.retire(row.publishedId, new Date().toISOString());
    return id;
  }

  flush(writes: D1Write[]) {
    if (this.changedCategories.size)
      writes.push(
        ...rowBatchesD1(questionCategories, [...this.changedCategories.values()], true),
      );
    if (this.changedTags.size)
      writes.push(...rowBatchesD1(questionTags, [...this.changedTags.values()], true));
    if (this.changedAuthors.size)
      writes.push(
        ...rowBatchesD1(questionAuthors, [...this.changedAuthors.values()], true),
      );
    if (this.configuration)
      writes.push(...rowBatchesD1(questionSettings, [this.configuration], true));
    if (this.newVersions.length)
      writes.push(...rowBatchesD1(questionVersions, this.newVersions));
    if (this.availability.size)
      writes.push(
        ...rowBatchesD1(questionAvailability, [...this.availability.values()], true),
      );
    if (this.changedSubmissions.size)
      writes.push(
        ...rowBatchesD1(questionSubmissions, [...this.changedSubmissions.values()], true),
      );
    if (this.changedDifficulty.size)
      writes.push(
        ...rowBatchesD1(questionDifficulty, [...this.changedDifficulty.values()], true),
      );
    if (this.events.length)
      writes.push(...rowBatchesD1(questionSubmissionEvents, this.events));
    if (this.notifications.length)
      writes.push(...rowBatchesD1(questionNotifications, this.notifications));
  }
}
