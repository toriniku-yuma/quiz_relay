import { useState } from 'react';
import {
  type BroughtQuestion,
  emptyBroughtQuestion,
  parseBroughtJson,
} from '../../../shared/rooms';
import Button from '../../components/Button';
import TextField from '../../components/TextField';

export default function BroughtEditor({
  questions,
  onChange,
  disabled = false,
}: {
  questions: BroughtQuestion[];
  onChange: (questions: BroughtQuestion[]) => void;
  disabled?: boolean;
}) {
  const [json, setJson] = useState(''),
    [error, setError] = useState('');
  const update = (index: number, change: Partial<BroughtQuestion>) =>
    onChange(questions.map((q, i) => (i === index ? { ...q, ...change } : q)));
  function importJson(source: string) {
    try {
      const imported = parseBroughtJson(source);
      if (questions.length + imported.length > 500)
        throw new Error('合計500問までです。');
      onChange([
        ...questions.filter((q) => q.text || q.displayAnswer || q.readings.some(Boolean)),
        ...imported,
      ]);
      setError('');
      setJson('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'JSONを確認してください。');
    }
  }
  return (
    <section className="grid gap-4">
      <p>
        部屋用の問題です。共通問題への投稿ではありません。問題文・表示用の答え・ひらがなの読みは必須、解説は任意です。
      </p>
      {questions.map((q, index) => (
        <fieldset
          // biome-ignore lint/suspicious/noArrayIndexKey: Controlled rows have no saved identity; length changes remount rows after insertion/deletion.
          key={`question-${index}-${questions.length}`}
          disabled={disabled}
          className="grid gap-3 border border-line p-4"
        >
          <legend>問題{index + 1}</legend>
          <TextField
            id={`brought-text-${index}`}
            label="問題文（150文字まで）"
            placeholder="例：日本の首都はどこ？"
            required
            value={q.text}
            onChange={(e) => update(index, { text: e.target.value })}
          />
          <TextField
            id={`brought-answer-${index}`}
            label="表示用の答え（20文字まで）"
            placeholder="例：東京"
            required
            value={q.displayAnswer}
            onChange={(e) => update(index, { displayAnswer: e.target.value })}
          />
          <TextField
            id={`brought-reading-${index}`}
            label="ひらがなの読み（複数は読点で区切る）"
            placeholder="例：とうきょう"
            required
            value={q.readings.join('、')}
            onChange={(e) => update(index, { readings: e.target.value.split(/[、,]/u) })}
          />
          <TextField
            id={`brought-explanation-${index}`}
            label="解説（任意・300文字まで）"
            placeholder="例：東京都にあります。"
            value={q.explanation}
            onChange={(e) => update(index, { explanation: e.target.value })}
          />
          <Button onClick={() => onChange(questions.filter((_, i) => i !== index))}>
            この問題を削除
          </Button>
        </fieldset>
      ))}
      <Button
        disabled={disabled || questions.length >= 500}
        onClick={() => onChange([...questions, emptyBroughtQuestion()])}
      >
        フォームで問題を追加
      </Button>
      <details className="border border-line p-4">
        <summary>JSONから問題を追加</summary>
        <div className="mt-3 grid gap-3">
          <label htmlFor="brought-file">JSONファイル（複数選択可）</label>
          <input
            id="brought-file"
            type="file"
            accept=".json,application/json"
            multiple
            disabled={disabled}
            onChange={async (e) => {
              try {
                const files = Array.from(e.target.files ?? []);
                const imported = (
                  await Promise.all(
                    files.map(async (f) => {
                      if (f.size > 2 * 1024 * 1024)
                        throw new Error('各ファイルは2MBまでです。');
                      return parseBroughtJson(await f.text());
                    }),
                  )
                ).flat();
                const current = questions.filter(
                  (q) => q.text || q.displayAnswer || q.readings.some(Boolean),
                );
                if (current.length + imported.length > 500)
                  throw new Error('合計500問までです。');
                onChange([...current, ...imported]);
                setError('');
              } catch (error) {
                setError(
                  error instanceof Error ? error.message : '読み込めませんでした。',
                );
              }
              e.target.value = '';
            }}
          />
          <label htmlFor="brought-json">JSONの直接入力</label>
          <textarea
            id="brought-json"
            className="min-h-36 border border-line bg-input p-3"
            value={json}
            disabled={disabled}
            placeholder={
              '{"version":1,"questions":[{"text":"日本の首都はどこ？","displayAnswer":"東京","readings":["とうきょう"]}]}'
            }
            onChange={(e) => setJson(e.target.value)}
          />
          <Button disabled={disabled || !json} onClick={() => importJson(json)}>
            JSONを確認して追加
          </Button>
        </div>
      </details>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
