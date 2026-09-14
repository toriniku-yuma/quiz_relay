export const graphemes = (text: string) =>
  Array.from(
    new Intl.Segmenter('ja', { granularity: 'grapheme' }).segment(
      text.normalize('NFKC').trim(),
    ),
    ({ segment }) => segment,
  );

export type Question = {
  id: string;
  text: string;
  answer: string;
  explanation: string;
  distractors?: string[];
};

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
