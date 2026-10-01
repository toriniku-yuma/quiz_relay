import { type QuestionInput, validateQuestionInput } from './questions.ts';

// JSON.parse keeps the last duplicate key silently. Inspect object keys before parsing.
export function readQuestionJson(source: string): unknown {
  if (new TextEncoder().encode(source).length > 2000000)
    throw new Error('JSONは2MB以内にしてください。');
  let position = 0;
  const whitespace = () => {
    while (/\s/u.test(source[position] ?? '') && position < source.length) position++;
  };
  const error = (message: string): never => {
    const lines = source.slice(0, position).split('\n');
    throw new Error(
      `${lines.length}行 ${lines[lines.length - 1].length + 1}列：${message}`,
    );
  };
  function string(): string {
    const start = position++;
    while (position < source.length) {
      if (source[position] === '\\') position += 2;
      else if (source[position++] === '"')
        return JSON.parse(source.slice(start, position));
    }
    return error('文字列が閉じられていません。');
  }
  function value(depth = 0): void {
    if (depth > 20) error('JSONの入れ子が深すぎます。');
    whitespace();
    if (source[position] === '"') {
      string();
      return;
    }
    const open = source[position];
    if (open === '{' || open === '[') {
      position++;
      whitespace();
      const close = open === '{' ? '}' : ']';
      const keys = new Set<string>();
      if (source[position] === close) {
        position++;
        return;
      }
      while (position < source.length) {
        if (open === '{') {
          whitespace();
          if (source[position] !== '"') error('項目名を確認してください。');
          const key = string();
          if (keys.has(key)) error(`項目「${key}」が重複しています。`);
          keys.add(key);
          whitespace();
          if (source[position++] !== ':') error('コロンが必要です。');
        }
        value(depth + 1);
        whitespace();
        if (source[position] === close) {
          position++;
          return;
        }
        if (source[position++] !== ',') error('区切りを確認してください。');
      }
      error('JSONが閉じられていません。');
    }
    const match =
      /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/u.exec(
        source.slice(position),
      );
    if (!match) error('値を確認してください。');
    else position += match[0].length;
  }
  value();
  whitespace();
  if (position !== source.length) error('余分な文字があります。');
  return JSON.parse(source);
}
export function parseQuestionJson(source: string): QuestionInput[] {
  const parsed = readQuestionJson(source) as { version: number; questions: unknown[] };
  if (
    !parsed ||
    Object.keys(parsed).sort().join(',') !== 'questions,version' ||
    parsed.version !== 1 ||
    !Array.isArray(parsed.questions) ||
    parsed.questions.length < 1 ||
    parsed.questions.length > 500
  )
    throw new Error('version: 1 と、1〜500問の questions を指定してください。');
  return parsed.questions.map((input, index) => {
    const result = validateQuestionInput(input, false);
    if (result.issues.length)
      throw new Error(
        result.issues
          .map((issue) => `問題${index + 1} ${issue.path}：${issue.message}`)
          .join('\n'),
      );
    return result.value;
  });
}

export function exportQuestionJson<T>(questions: T[]): string[] {
  const files: string[] = [];
  let current: T[] = [];
  const encode = (values: T[]) => JSON.stringify({ version: 1, questions: values });
  const bytes = (value: string) => new TextEncoder().encode(value).length;
  for (const question of questions) {
    if (bytes(encode([question])) > 2000000)
      throw new Error('1問が2MBを超えています。原文を保持したまま出力を中止しました。');
    if (current.length === 500 || bytes(encode([...current, question])) > 2000000) {
      files.push(encode(current));
      current = [];
    }
    current.push(question);
  }
  if (current.length) files.push(encode(current));
  return files;
}
