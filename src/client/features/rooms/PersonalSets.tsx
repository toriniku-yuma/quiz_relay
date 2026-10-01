import { useCallback, useEffect, useState } from 'react';
import { API_PATHS } from '../../../shared/api-paths';
import { type BroughtQuestion, validateBroughtSet } from '../../../shared/rooms';
import Button from '../../components/Button';
import DataTable from '../../components/DataTable';
import Panel from '../../components/Panel';
import TextField from '../../components/TextField';
import { useMutation } from '../moderation/useMutation';
import { playRequest } from './api';
import BroughtEditor from './BroughtEditor';

export type PersonalSet = {
  id: string;
  name: string;
  revision: number;
  questions: BroughtQuestion[];
};
export default function PersonalSets() {
  const [sets, setSets] = useState<PersonalSet[]>([]),
    [current, setCurrent] = useState<PersonalSet | null>(null),
    [error, setError] = useState('');
  const refresh = useCallback(async () => {
    try {
      setSets((await playRequest<{ sets: PersonalSet[] }>(API_PATHS.personalSets)).sets);
    } catch (e) {
      setError(e instanceof Error ? e.message : '読み込めませんでした。');
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const mutation = useMutation(
    API_PATHS.personalSets,
    async () => {
      setCurrent(null);
      await refresh();
    },
    playRequest,
  );
  const locked = mutation.busy || mutation.uncertain;
  return (
    <Panel title="自分の部屋用問題セット">
      <p className="my-3">
        組織内の各インスタンスで、作成者本人だけが再利用できます。保存したセットは、削除または退会まで保持します。
      </p>
      <Button
        disabled={locked}
        onClick={() =>
          setCurrent({ id: crypto.randomUUID(), revision: 0, name: '', questions: [] })
        }
      >
        新しいセット
      </Button>
      <DataTable label="自分の問題セット" columns={['名前', '問題数', '操作']}>
        {sets.map((s) => (
          <tr key={s.id}>
            <td>{s.name}</td>
            <td>{s.questions.length}</td>
            <td>
              <Button disabled={locked} onClick={() => setCurrent(structuredClone(s))}>
                編集・再利用
              </Button>
              <Button
                disabled={locked}
                onClick={() => {
                  const link = document.createElement('a');
                  const url = URL.createObjectURL(
                    new Blob(
                      [JSON.stringify({ version: 1, questions: s.questions }, null, 2)],
                      { type: 'application/json' },
                    ),
                  );
                  link.href = url;
                  link.download = 'room-questions.json';
                  link.click();
                  URL.revokeObjectURL(url);
                }}
              >
                JSON出力
              </Button>
              <Button
                disabled={locked}
                onClick={() =>
                  void mutation.submit({
                    id: s.id,
                    revision: s.revision,
                    action: 'delete',
                  })
                }
              >
                削除
              </Button>
            </td>
          </tr>
        ))}
      </DataTable>
      {current && (
        <form
          className="mt-5 grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            try {
              const questions = validateBroughtSet(current.questions);
              setError('');
              void mutation.submit({
                id: current.id,
                name: current.name,
                questions,
                revision: current.revision,
                action: 'save',
              });
            } catch (e) {
              setError(e instanceof Error ? e.message : '入力を確認してください。');
            }
          }}
        >
          <TextField
            id="personal-set-name"
            label="セット名"
            placeholder="例：地理の練習"
            required
            maxLength={80}
            value={current.name}
            disabled={locked}
            onChange={(e) => setCurrent({ ...current, name: e.target.value })}
          />
          <BroughtEditor
            questions={current.questions}
            onChange={(questions) => setCurrent({ ...current, questions })}
            disabled={locked}
          />
          <Button type="submit" disabled={mutation.busy}>
            {mutation.uncertain ? '同じ内容で再試行' : '自分のセットとして保存'}
          </Button>
          <Button disabled={locked} onClick={() => setCurrent(null)}>
            編集を閉じる
          </Button>
        </form>
      )}
      {(error || mutation.error) && <p role="alert">{error || mutation.error}</p>}
      {mutation.uncertain && (
        <p>
          保存結果を確認できていません。入力を維持して同じ操作で再試行してください。
          <Button disabled={mutation.busy} onClick={() => void mutation.submit({})}>
            同じ内容で再試行
          </Button>
        </p>
      )}
    </Panel>
  );
}
