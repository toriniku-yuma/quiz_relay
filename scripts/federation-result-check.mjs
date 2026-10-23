import assert from 'node:assert/strict';

export function assertMatchResult(expected, actual) {
  assert(actual, 'result missing');
  assert.equal(actual.matchId, expected.matchId, 'match identity');
  for (const key of ['reason', 'winnerId', 'finishedAt'])
    assert.equal(actual[key], expected[key], `result ${key}`);
  const players = (items) =>
    items
      .map((player) => ({
        id: player.id,
        correct: player.correct,
        mistakes: player.mistakes,
        disqualified: player.disqualified,
        forfeited: player.forfeited === true,
        presenter: player.role === 'presenter',
      }))
      .sort((left, right) => left.id.localeCompare(right.id));
  assert.deepEqual(players(actual.players), players(expected.players), 'player outcomes');
}
