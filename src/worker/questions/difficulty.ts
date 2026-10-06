export type DifficultySample = { trials: number; correct: number; participants: number };

export function wilson(sample: DifficultySample) {
  const { trials: trialCount, correct: correctCount } = sample;
  if (
    !Number.isSafeInteger(trialCount) ||
    !Number.isSafeInteger(correctCount) ||
    trialCount < 0 ||
    correctCount < 0 ||
    correctCount > trialCount
  )
    throw new Error('INVALID_SAMPLE');
  if (!trialCount) return { lower: 0, upper: 1 };
  const zScore = 1.959963984540054;
  const correctRate = correctCount / trialCount;
  const denominator = 1 + (zScore * zScore) / trialCount;
  const center = (correctRate + (zScore * zScore) / (2 * trialCount)) / denominator;
  const half =
    (zScore *
      Math.sqrt(
        (correctRate * (1 - correctRate)) / trialCount +
          (zScore * zScore) / (4 * trialCount * trialCount),
      )) /
    denominator;
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
