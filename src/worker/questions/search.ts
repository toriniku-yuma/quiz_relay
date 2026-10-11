import { normalizeTag, type QuestionInput } from '../../shared/questions.ts';

export function questionSearchText(input: QuestionInput) {
  return normalizeTag(
    [input.text, input.displayAnswer, ...input.readings, ...input.tags].join(' '),
  );
}
