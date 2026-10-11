import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { connectD1 } from '../src/worker/db/d1.ts';

// Offline operator tools use the same native local binding as Vite. Stop writes before recovery.
export async function localD1() {
  const config = JSON.parse(readFileSync('wrangler.jsonc', 'utf8')) as {
    d1_databases: { binding: string; database_id: string }[];
  };
  const id = config.d1_databases.find(
    (entry) => entry.binding === 'GAME_D1',
  )?.database_id;
  if (!id) throw new Error('GAME_D1_CONFIGURATION_REQUIRED');
  const require = createRequire(
    realpathSync('node_modules/@cloudflare/vitest-plugin/package.json'),
  );
  const { Miniflare, convertV4MiniflareOptions } = require('miniflare') as {
    convertV4MiniflareOptions(options: unknown): unknown;
    Miniflare: new (
      options: unknown,
    ) => {
      getD1Database(name: string): Promise<D1Database>;
      dispose(): Promise<void>;
    };
  };
  const runtime = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: 'export default { fetch() { return new Response("offline operator"); } }',
      compatibilityDate: '2026-09-08',
      d1Databases: { GAME_D1: id },
      resourcePersistencePath: resolve('.wrangler/state/v3'),
    }),
  );
  try {
    const binding = await runtime.getD1Database('GAME_D1');
    return { binding, db: connectD1(binding), close: () => runtime.dispose() };
  } catch (error) {
    await runtime.dispose();
    throw error;
  }
}
