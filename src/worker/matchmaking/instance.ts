import type { Env } from '../env.ts';

export function matchmaker(env: Pick<Env, 'MATCHMAKER'>) {
  return env.MATCHMAKER.getByName('matchmaker');
}
