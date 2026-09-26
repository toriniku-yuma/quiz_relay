export type DifficultySample = { trials: number; correct: number; participants: number };

export function wilson(sample: DifficultySample) {
  const { trials: n, correct: k } = sample;
  if (!Number.isSafeInteger(n) || !Number.isSafeInteger(k) || n < 0 || k < 0 || k > n)
    throw new Error('INVALID_SAMPLE');
  if (!n) return { lower: 0, upper: 1 };
  const z = 1.959963984540054;
  const p = k / n;
  const denominator = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / denominator;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denominator;
  return { lower: Math.max(0, center - half), upper: Math.min(1, center + half) };
}

export function estimateDifficulty(
  current: number,
  samples: (DifficultySample | undefined)[],
  fixed = false,
) {
  const enough = (sample: DifficultySample | undefined): sample is DifficultySample =>
    !!sample && sample.trials >= 50 && sample.participants >= 20;
  const own = samples[current];
  const lower = samples[current - 1];
  if (fixed) return { current, reason: '管理者が固定しています。' };
  const harder = current < 2 && enough(own) && wilson(own).upper < 0.5;
  const easier = current > 0 && enough(lower) && wilson(lower).lower > 0.8;
  if (harder && easier)
    return { current, reason: '上下の判定が矛盾するため維持しました。' };
  if (harder)
    return {
      current: current + 1,
      reason: '対応実力帯のWilson上限が50%未満のため1段階上げました。',
    };
  if (easier)
    return {
      current: current - 1,
      reason: '1つ下の実力帯のWilson下限が80%超のため1段階下げました。',
    };
  return { current, reason: 'データ不足または判定境界内のため維持しました。' };
}
