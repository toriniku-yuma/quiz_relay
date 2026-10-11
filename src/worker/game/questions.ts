export const graphemes = (text: string) =>
  Array.from(
    new Intl.Segmenter('ja', { granularity: 'grapheme' }).segment(
      text.normalize('NFKC').trim(),
    ),
    ({ segment }) => segment,
  );

export type Question = {
  authorName?: string;
  id: string;
  text: string;
  answer: string;
  explanation: string;
  distractors?: string[];
  readings?: string[];
  displayAnswer?: string;
  traps?: { answer: string; reading: string }[];
  categoryId?: string;
  difficulty?: number;
  seriesId?: string;
  generation?: string;
  sharedSource?: {
    authorId: string;
    peerOrigin: string;
    instanceId: string;
    questionId: string;
    seriesId: string;
  };
};

export const answerReadings = (question: Question) =>
  question.readings ?? [question.answer];

export function orderQuestions(
  source: Question[],
  band: number,
  configuredWeights?: number[],
  categoryWeights: Record<string, number> = {},
) {
  const weights =
    configuredWeights ??
    [
      [1, 0, 0],
      [0.3, 0.7, 0],
      [0.1, 0.3, 0.6],
    ][band];
  const remaining = [...source];
  const ordered: Question[] = [];
  const random = () => crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32;
  while (remaining.length) {
    const levels = [0, 1, 2].filter(
      (level) =>
        weights[level] > 0 &&
        remaining.some((candidateQuestion) => candidateQuestion.difficulty === level),
    );
    if (!levels.length) break;
    let draw = random() * levels.reduce((sum, level) => sum + weights[level], 0);
    const difficulty =
      levels.find((level) => {
        draw -= weights[level];
        return draw < 0;
      }) ?? levels[levels.length - 1];
    const categories = [
      ...new Set(
        remaining
          .filter((candidateQuestion) => candidateQuestion.difficulty === difficulty)
          .map((candidateQuestion) => candidateQuestion.categoryId),
      ),
    ];
    const eligibleCategories = categories.filter(
      (categoryId) => (categoryWeights[categoryId ?? ''] ?? 1) > 0,
    );
    if (!eligibleCategories.length) {
      for (let i = remaining.length - 1; i >= 0; i--)
        if (remaining[i].difficulty === difficulty) remaining.splice(i, 1);
      continue;
    }
    let categoryDraw =
      random() *
      eligibleCategories.reduce(
        (sum, categoryId) => sum + (categoryWeights[categoryId ?? ''] ?? 1),
        0,
      );
    const category =
      eligibleCategories.find((categoryId) => {
        categoryDraw -= categoryWeights[categoryId ?? ''] ?? 1;
        return categoryDraw < 0;
      }) ?? eligibleCategories[eligibleCategories.length - 1];
    const candidates = remaining.filter(
      (candidateQuestion) =>
        candidateQuestion.difficulty === difficulty &&
        candidateQuestion.categoryId === category,
    );
    const question = candidates[Math.floor(random() * candidates.length)];
    ordered.push(question);
    remaining.splice(remaining.indexOf(question), 1);
  }
  return ordered;
}

export function readingChoices(question: Question, prefix: string) {
  const position = graphemes(prefix).length;
  const correct = [
    ...new Set(
      answerReadings(question)
        .filter((reading) => reading.startsWith(prefix))
        .map((reading) => graphemes(reading)[position])
        .filter(Boolean),
    ),
  ];
  if (!correct.length || correct.length > 4) throw new Error('INVALID_CHOICES');
  const traps = (question.traps ?? [])
    .filter((trap) => trap.reading.startsWith(prefix))
    .map((trap) => graphemes(trap.reading)[position])
    .filter(Boolean);
  const candidates = [
    ...new Set([...traps, ...(question.distractors ?? []), ...dummyCharacters]),
  ].filter((character) => !correct.includes(character));
  const sample = [...correct];
  while (sample.length < 4) {
    const index = Math.floor(
      (crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32) * candidates.length,
    );
    sample.push(candidates.splice(index, 1)[0]);
  }
  for (let i = sample.length - 1; i > 0; i--) {
    const j = Math.floor(
      (crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32) * (i + 1),
    );
    [sample[i], sample[j]] = [sample[j], sample[i]];
  }
  return sample.map((text) => ({ id: crypto.randomUUID(), text }));
}

export const dummyCharacters = graphemes(
  'あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわをんがぎぐげござじずぜぞだぢづでどばびぶべぼぱぴぷぺぽぁぃぅぇぉゃゅょっー',
);

export function choicesFor(
  correct: string,
  choiceCount = 4,
  distractors = dummyCharacters,
) {
  const candidates = [...new Set(distractors)].filter((text) => text !== correct);
  if (
    !Number.isInteger(choiceCount) ||
    choiceCount < 2 ||
    choiceCount > 8 ||
    graphemes(correct).length !== 1 ||
    !/^[ぁ-ゖー]+$/u.test(correct) ||
    candidates.length < choiceCount - 1
  )
    throw new Error('INVALID_QUESTION');

  const sample = [correct];
  while (sample.length < choiceCount) {
    const random = crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32;
    sample.push(candidates.splice(Math.floor(random * candidates.length), 1)[0]);
  }

  for (let i = sample.length - 1; i > 0; i--) {
    const j = Math.floor(
      (crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32) * (i + 1),
    );
    [sample[i], sample[j]] = [sample[j], sample[i]];
  }

  return sample.map((text) => ({ id: crypto.randomUUID(), text }));
}
