import values from '../../../config/rating.json' with { type: 'json' };
import type { Player, Result } from '../../shared/game.ts';

export type MatchKind = 'ranked' | 'casual' | 'room' | 'development';

export const ratingPolicy = values;

if (values.version !== 1 || values.initial !== 1000 || values.change !== 20)
  throw new Error('UNSUPPORTED_RATING_POLICY');

export function ratingChange(kind: MatchKind, result: Result, player: Player) {
  if (kind !== 'ranked') return 0;
  if (player.disqualified || !player.connected) return -values.change;
  if (result.reason === 'connections' || result.reason === 'disqualifications')
    return values.change;
  if (!result.winnerId) return 0;
  return result.winnerId === player.id ? values.change : -values.change;
}
