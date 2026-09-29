import { readQuestionJson } from './question-json.ts';
import { type QuestionInput, validateQuestionInput } from './questions.ts';
export type TransferQuestion = {
  input: QuestionInput;
  category: string;
  stopped: boolean;
  provenance: { author: string; instance: string };
};
export function parseTransfer(source: string): TransferQuestion[] {
  const value = readQuestionJson(source) as { version?: unknown; questions?: unknown };
  if (
    value?.version !== 2 ||
    !Array.isArray(value.questions) ||
    !value.questions.length ||
    value.questions.length > 500
  )
    throw Error('移行JSONはversion:2、1〜500問で指定してください。');
  return value.questions.map((row, index) => {
    if (!row || typeof row !== 'object') throw Error('問題の形式を確認してください。');
    const parsed = validateQuestionInput(row.input, false);
    if (parsed.issues.length)
      throw Error(`問題${index + 1}：${parsed.issues.map((i) => i.message).join(' ')}`);
    if (
      typeof row.category !== 'string' ||
      row.category.length > 80 ||
      typeof row.stopped !== 'boolean' ||
      !row.provenance ||
      typeof row.provenance.author !== 'string' ||
      row.provenance.author.length > 200 ||
      typeof row.provenance.instance !== 'string' ||
      row.provenance.instance.length > 200
    )
      throw Error('カテゴリ・作問者・出力元・停止状態を確認してください。');
    return {
      input: parsed.value,
      category: row.category,
      stopped: row.stopped,
      provenance: { author: row.provenance.author, instance: row.provenance.instance },
    };
  });
}
export function exportTransfer(rows: TransferQuestion[]): string[] {
  const files: string[] = [],
    encode = (q: TransferQuestion[]) =>
      JSON.stringify({ version: 2, questions: q }, null, 2),
    bytes = (s: string) => new TextEncoder().encode(s).length;
  let part: TransferQuestion[] = [];
  for (const row of rows) {
    if (bytes(encode([row])) > 2000000) throw Error('1問が出力上限を超えています。');
    if (part.length === 500 || bytes(encode([...part, row])) > 2000000) {
      files.push(encode(part));
      part = [];
    }
    part.push(row);
  }
  if (part.length) files.push(encode(part));
  return files;
}
