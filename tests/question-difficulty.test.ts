import { describe, expect, it } from 'vitest';
import { estimateDifficulty, wilson } from '../src/worker/questions/difficulty';

describe('難易度のWilson判定', () => {
  it('未観測と端点を扱う', () => {
    expect(wilson({ trials: 0, correct: 0, participants: 0 })).toEqual({
      lower: 0,
      upper: 1,
    });
    expect(wilson({ trials: 50, correct: 0, participants: 20 }).upper).toBeCloseTo(
      0.0713476,
    );
    expect(wilson({ trials: 50, correct: 50, participants: 20 }).lower).toBeCloseTo(
      0.9286524,
    );
  });
  it('回数・参加者・固定条件を省略しない', () => {
    expect(
      estimateDifficulty(0, [{ trials: 49, correct: 0, participants: 20 }]).current,
    ).toBe(0);
    expect(
      estimateDifficulty(0, [{ trials: 50, correct: 0, participants: 19 }]).current,
    ).toBe(0);
    expect(
      estimateDifficulty(0, [{ trials: 50, correct: 0, participants: 20 }], true).current,
    ).toBe(0);
    expect(
      estimateDifficulty(0, [{ trials: 50, correct: 0, participants: 20 }]).current,
    ).toBe(1);
  });
  it('下位帯の根拠不足と矛盾では維持する', () => {
    const easy = { trials: 50, correct: 50, participants: 20 };
    const hard = { trials: 50, correct: 0, participants: 20 };
    expect(estimateDifficulty(2, [undefined, undefined, easy]).current).toBe(2);
    expect(estimateDifficulty(2, [undefined, easy]).current).toBe(1);
    expect(estimateDifficulty(1, [easy, hard]).current).toBe(1);
    expect(
      estimateDifficulty(1, [undefined, { trials: 50, correct: 25, participants: 20 }])
        .current,
    ).toBe(1);
  });
});
