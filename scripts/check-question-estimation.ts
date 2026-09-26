import { estimateDifficulty } from '../src/worker/questions/difficulty.ts';

// Reproducible synthetic sensitivity check; this is not validation against real players.
let seed = 20260925;
const random = () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 2 ** 32;
};
const rows = [];
for (const probability of [0.2, 0.5, 0.8, 0.95]) {
  for (const repeated of [false, true]) {
    let harder = 0;
    let easier = 0;
    for (let iteration = 0; iteration < 10000; iteration++) {
      const count = repeated ? 10 : 50;
      let correct = 0;
      for (let i = 0; i < count; i++)
        if (random() < probability) correct += repeated ? 5 : 1;
      const sample = { trials: 50, correct, participants: 20 };
      if (estimateDifficulty(0, [sample]).current === 1) harder++;
      if (estimateDifficulty(1, [sample]).current === 0) easier++;
    }
    rows.push({
      trueProbability: probability,
      model: repeated ? '10組の成否を各5回反復' : '独立50試行',
      harderPercent: harder / 100,
      easierPercent: easier / 100,
    });
  }
}
console.table(rows);
