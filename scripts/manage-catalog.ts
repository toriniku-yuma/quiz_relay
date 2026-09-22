import { readFile } from 'node:fs/promises';
import defaults from '../config/matchmaking.json' with { type: 'json' };
import {
  listCatalog,
  manageCatalog,
  validateCatalogOperation,
} from '../src/worker/catalog/manage.ts';
import { connectDatabase } from '../src/worker/db/connection.ts';

async function main() {
  const [path, flag, ...extra] = process.argv.slice(2);
  const owner = process.env.GAME_OWNER ?? defaults.owner;
  if (
    !owner ||
    !path ||
    extra.length ||
    (flag && flag !== '--apply') ||
    (path === '--list' && flag)
  )
    throw new Error('INVALID_ARGUMENTS');
  let input: ReturnType<typeof validateCatalogOperation> | undefined;
  if (path !== '--list') {
    const bytes = await readFile(path);
    if (bytes.length > 65536) throw new Error('INPUT_TOO_LARGE');
    input = validateCatalogOperation(
      JSON.parse(new TextDecoder().decode(bytes).replace(/^\uFEFF/, '')),
      owner,
    );
    if (flag !== '--apply') {
      const summary =
        'question' in input
          ? {
              operation: input.operation,
              questionId: input.question.id,
              ...('questionId' in input ? { originalQuestionId: input.questionId } : {}),
            }
          : input;
      console.log(
        JSON.stringify({
          owner,
          ...summary,
          valid: true,
          applied: false,
        }),
      );
      return;
    }
  }
  const url = process.env.GAME_CATALOG_DATABASE_URL;
  if (!url) throw new Error('CATALOG_DATABASE_REQUIRED');
  const { db, close } = connectDatabase(url, process.env.DATABASE_CA_CERT);
  try {
    console.log(
      JSON.stringify(
        path === '--list'
          ? await listCatalog(db, owner)
          : await manageCatalog(db, owner, input),
        null,
        2,
      ),
    );
  } finally {
    await close();
  }
}
main().catch((error) => {
  const allowed = [
    'INVALID_ARGUMENTS',
    'INPUT_TOO_LARGE',
    'INVALID_OPERATION',
    'INVALID_QUESTION',
    'INVALID_CHOICES',
    'INVALID_VERSION',
    'INVALID_QUESTION_SET',
    'OWNER_MISMATCH',
    'REVISION_REQUIRES_NEW_ID',
    'QUESTION_NOT_FOUND',
    'QUESTION_ID_CONFLICT',
    'QUESTION_UNAVAILABLE',
    'CATALOG_FORBIDDEN',
    'CATALOG_DATABASE_REQUIRED',
  ];
  console.error(
    allowed.includes(error?.message) ? error.message : 'CATALOG_OPERATION_FAILED',
  );
  process.exitCode = 1;
});
