import { sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

// Local verification provisioning only. This function is never imported by the deployed Worker.
export async function provisionLocalQuestionPermissions(
  db: PostgresJsDatabase,
  address: string,
) {
  const target = new URL(address);
  if (
    target.hostname !== '127.0.0.1' ||
    !['/quiz_relay_dev', '/quiz_relay_questions_test'].includes(target.pathname) ||
    !['55432', '55439'].includes(target.port)
  )
    throw new Error('LOCAL_QUESTION_DATABASE_REQUIRED');
  const mutable = [
    'question_settings',
    'question_categories',
    'question_submissions',
    'question_authors',
    'question_notifications',
    'question_tags',
    'question_review_cases',
    'question_difficulty',
  ];
  const appendOnly = [
    'question_submission_events',
    'question_imports',
    'question_reports',
  ];
  await db.transaction(async (tx) => {
    for (const name of [...mutable, ...appendOnly]) {
      await tx.execute(
        sql.raw(`REVOKE ALL ON quiz_game.${name} FROM PUBLIC, anon, authenticated`),
      );
      await tx.execute(
        sql.raw(
          `GRANT SELECT, INSERT${mutable.includes(name) ? ', UPDATE' : ''} ON quiz_game.${name} TO quiz_organization`,
        ),
      );
      await tx.execute(
        sql.raw(`DROP POLICY IF EXISTS organization_service ON quiz_game.${name}`),
      );
      await tx.execute(
        sql.raw(
          `CREATE POLICY organization_service ON quiz_game.${name} FOR ALL TO quiz_organization USING (instance_id IN (SELECT id FROM quiz_game.instances WHERE organization_id::text = current_setting('quiz.organization_id', true))) WITH CHECK (instance_id IN (SELECT id FROM quiz_game.instances WHERE organization_id::text = current_setting('quiz.organization_id', true)))`,
        ),
      );
    }
  });
}
