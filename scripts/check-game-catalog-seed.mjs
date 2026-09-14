import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, rmdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const directory = await mkdtemp(join(tmpdir(), 'quiz-seed-'));
const config = join(directory, 'config.json');
const defaults = JSON.parse(await readFile('config/matchmaking.json', 'utf8'));
const run = (path) =>
  spawnSync(process.execPath, ['scripts/game-catalog-seed.ts', path], {
    encoding: 'utf8',
  });
try {
  for (const playersPerMatch of [2, 3, 4]) {
    await writeFile(config, JSON.stringify({ ...defaults, playersPerMatch }));
    const result = run(config);
    assert.equal(result.status, 0, result.stderr);
    const preview = JSON.parse(result.stdout);
    assert.equal(preview.playersPerMatch, playersPerMatch);
    assert.equal(preview.questionCount, 12);
    assert.equal(preview.applied, false);
    assert.equal(
      preview.manifestHash,
      '1d6811bf21c02f97ca3021375abbcad2c33895ffbe8f328957f5f86032cca4af',
    );
  }
  for (const playersPerMatch of [1, 5, '4', null]) {
    await writeFile(config, JSON.stringify({ ...defaults, playersPerMatch }));
    assert.notEqual(run(config).status, 0);
  }
  console.log(
    'PASS: seed preview validates config and unchanged question hash without DB access',
  );
} finally {
  await rm(config, { force: true });
  await rmdir(directory);
}
