import { afterEach, expect, it, vi } from 'vitest';
import defaults from '../config/matchmaking.json';

afterEach(() => {
  vi.doUnmock('../config/matchmaking.json');
  vi.resetModules();
});

it.each(Object.keys(defaults.rules))(
  'rejects a default JSON missing %s at module initialization',
  async (key) => {
    const broken: Record<string, unknown> = { ...defaults.rules };
    delete broken[key];
    vi.doMock('../config/matchmaking.json', () => ({
      default: { ...defaults, rules: broken },
    }));
    await expect(import('../src/worker/game/rules')).rejects.toThrow('INVALID_RULES');
  },
);

it('rejects an unknown rule even when it is present in the default JSON', async () => {
  vi.doMock('../config/matchmaking.json', () => ({
    default: { ...defaults, rules: { ...defaults.rules, typo: 1 } },
  }));
  await expect(import('../src/worker/game/rules')).rejects.toThrow('INVALID_RULES');
});
