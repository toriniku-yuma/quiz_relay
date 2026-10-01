import defaults from '../../../config/matchmaking.json' with { type: 'json' };

// Supported fields and bounds are a contract, independent of editable default values.
const limits = {
  choiceCount: [4, 4],
  revealIntervalMs: [1, 10000],
  characterAnswerTimeMs: [1, 60000],
  judgedDisplayMs: [1, 60000],
  fullRevealWaitMs: [1, 60000],
  correctAnswersToWin: [1, 100],
  mistakesToDisqualify: [1, 100],
  reconnectGraceMs: [1, 60000],
} as const;
export type Rules = Record<keyof typeof limits, number> & {
  showSelections: boolean;
  winMode?: 'target' | 'questions';
  questionLimit?: number;
  noDisqualification?: boolean;
};

export function validateRules(value: unknown): Rules {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('INVALID_RULES');

  const config = value as Record<string, unknown>;
  if (
    Object.keys(config)
      .filter((key) => !['winMode', 'questionLimit', 'noDisqualification'].includes(key))
      .sort()
      .join(',') !== [...Object.keys(limits), 'showSelections'].sort().join(',') ||
    typeof config.showSelections !== 'boolean' ||
    Object.entries(limits).some(
      ([key, [min, max]]) =>
        !Number.isSafeInteger(config[key]) ||
        Number(config[key]) < min ||
        Number(config[key]) > max,
    )
  )
    throw new Error('INVALID_RULES');
  if (
    (config.winMode !== undefined &&
      config.winMode !== 'target' &&
      config.winMode !== 'questions') ||
    (config.questionLimit !== undefined &&
      (!Number.isInteger(config.questionLimit) ||
        Number(config.questionLimit) < 1 ||
        Number(config.questionLimit) > 100)) ||
    (config.winMode === 'questions' && config.questionLimit === undefined) ||
    (config.noDisqualification !== undefined &&
      typeof config.noDisqualification !== 'boolean')
  )
    throw new Error('INVALID_RULES');

  return { ...config } as Rules;
}

const { showSelections: _showSelections, ...defaultRules } = validateRules(
  defaults.rules,
);
export const rules = defaultRules;
