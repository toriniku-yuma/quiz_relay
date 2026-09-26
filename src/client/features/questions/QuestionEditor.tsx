import { useState } from 'react';
import {
  emptyQuestion,
  graphemes,
  type QuestionInput,
  type QuestionOverview,
  type Submission,
  validateQuestionInput,
} from '../../../shared/questions';
import Button from '../../components/Button';
import TextField from '../../components/TextField';

export default function QuestionEditor({
  row,
  categories,
  tags,
  busy,
  metadataPending = false,
  metadataFailed = false,
  save,
}: {
  row?: Submission;
  categories: QuestionOverview['categories'];
  tags: QuestionOverview['tags'];
  busy: boolean;
  metadataPending?: boolean;
  metadataFailed?: boolean;
  save: (input: QuestionInput) => Promise<boolean>;
}) {
  const [input, setInput] = useState<QuestionInput>(row?.input ?? emptyQuestion());
  const [issues, setIssues] = useState('');
  const [readings, setReadings] = useState(input.readings.join('\n'));
  const [trapText, setTrapText] = useState(
    input.traps.map((trap) => `${trap.answer}：${trap.reading}`).join('\n'),
  );
  const [tagText, setTagText] = useState(input.tags.join(', '));
  const limits = {
    text: 150,
    displayAnswer: 20,
    explanation: 300,
    evidence: 1000,
    source: 1000,
  };
  const fields = [
    ['text', '問題文（150文字）', '例：日本で一番高い山は？'],
    ['displayAnswer', '表示用正答（20文字）', '例：富士山'],
    ['explanation', '公開用解説（300文字）', '例：標高は3776メートルです。'],
    ['evidence', '正答の根拠（非公開・1000文字）', '例：国土地理院の資料で標高を確認'],
    ['source', '公開用出典（任意・1000文字）', '例：https://example.com/source'],
  ] as const;
  return (
    <form
      onSubmit={async (event) => {
        event.preventDefault();
        if (busy) return;
        const parsed = validateQuestionInput(
          {
            ...input,
            readings: readings.split('\n').filter(Boolean),
            tags: tagText
              .split(/[,、]/u)
              .map((s) => s.trim())
              .filter(Boolean),
            traps: trapText
              .split('\n')
              .filter(Boolean)
              .map((line) => {
                const parts = line.split(/[：:]/u);
                return {
                  answer: parts[0],
                  reading: parts.length === 2 ? parts[1] : undefined,
                };
              }),
          },
          false,
        );
        if (parsed.issues.length) {
          setIssues(parsed.issues.map((i) => `${i.path}: ${i.message}`).join('\n'));
          return;
        }
        setIssues('');
        await save(parsed.value);
      }}
      className="grid gap-4"
    >
      <h2 className="text-xl font-bold">{row ? '問題を編集' : '新しい問題'}</h2>
      <p>根拠は本人と担当運営者だけが閲覧できます。下書き保存後に提出します。</p>
      {fields.map(([key, label, placeholder]) => (
        <div key={key} className="grid gap-2">
          <label htmlFor={`question-${key}`} className="font-bold">
            {label}
          </label>
          <textarea
            id={`question-${key}`}
            placeholder={placeholder}
            rows={key === 'text' || key === 'explanation' ? 3 : 2}
            value={input[key]}
            onChange={(event) => setInput({ ...input, [key]: event.target.value })}
            className="w-full border border-line bg-input p-3"
            aria-invalid={graphemes(input[key]).length > limits[key]}
          />
          <p
            className={
              graphemes(input[key]).length > limits[key]
                ? 'font-bold text-accent'
                : 'text-sm text-muted'
            }
          >
            {graphemes(input[key]).length} / {limits[key]}文字
            {graphemes(input[key]).length > limits[key] ? '：上限を超えています。' : ''}
          </p>
        </div>
      ))}
      <label className="grid gap-2 font-bold">
        正解の読み（1行1種類・1〜8種類・各20文字）
        <textarea
          value={readings}
          onChange={(e) => setReadings(e.target.value)}
          placeholder={'例：ふじさん\nふじやま'}
          rows={3}
          className="border border-line bg-input p-3 font-normal"
        />
      </label>
      <label className="grid gap-2 font-bold">
        ひっかけ（任意・最大16件、答え：読み）
        <textarea
          value={trapText}
          onChange={(e) => setTrapText(e.target.value)}
          placeholder="例：北岳：きただけ"
          rows={2}
          className="border border-line bg-input p-3 font-normal"
        />
      </label>
      <label className="grid gap-2 font-bold">
        主カテゴリ
        <select
          disabled={metadataPending}
          value={input.categoryId}
          onChange={(e) => setInput({ ...input, categoryId: e.target.value })}
          className="border border-line bg-input p-3"
        >
          <option value="">
            {metadataPending
              ? metadataFailed
                ? 'カテゴリを取得できませんでした'
                : 'カテゴリを読み込み中'
              : '選択してください'}
          </option>
          {categories
            .filter((c) => c.active)
            .map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
        </select>
      </label>
      <label className="grid gap-2 font-bold">
        自己申告の難易度
        <select
          value={input.difficulty}
          onChange={(e) => setInput({ ...input, difficulty: Number(e.target.value) })}
          className="border border-line bg-input p-3"
        >
          {['初級', '中級', '上級'].map((name, index) => (
            <option key={name} value={index}>
              {name}
            </option>
          ))}
        </select>
      </label>
      <TextField
        id="question-tags"
        label="補足タグ（任意・カンマ区切り・10個まで）"
        placeholder="例：地理, 日本"
        value={tagText}
        onChange={(e) => setTagText(e.target.value)}
      />
      {tags.length > 0 && (
        <p className="text-muted">
          既存タグ：{[...new Set(tags.map((tag) => tag.name))].join('、')}
        </p>
      )}
      {issues && (
        <p role="alert" className="whitespace-pre-wrap">
          {issues}
        </p>
      )}
      {row?.publishedId && (
        <p>
          改訂が承認されるまでは公開中の旧版を使います。改訂しても使用停止は解除されません。
        </p>
      )}
      <Button type="submit" tone="primary" disabled={busy}>
        下書きを保存
      </Button>
    </form>
  );
}
