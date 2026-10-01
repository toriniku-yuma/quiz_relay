import { useState } from 'react';
import { API_PATHS } from '../../../shared/api-paths';
import type { OrganizationOverview } from '../../../shared/organization';
import Button from '../../components/Button';
import Modal from '../../components/Modal';
import TextField from '../../components/TextField';
import { useMutation } from '../moderation/useMutation';

export default function InstanceOperations({
  instance,
  refresh,
}: {
  instance: OrganizationOverview['instances'][number];
  refresh: () => Promise<boolean>;
}) {
  const [selected, setSelected] = useState<{
    action: string;
    title: string;
    stopping: boolean;
    revision: number;
  } | null>(null);
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const mutation = useMutation(API_PATHS.organizationOperation, async () => {
    setOpen(false);
    setSelected(null);
    setReason('');
    if (!(await refresh())) throw new Error('REFRESH_FAILED');
  });
  const actions = [
    {
      action: instance.state === 'published' ? 'prepare' : 'publish',
      title: instance.state === 'published' ? '準備中に戻す' : '公開する',
      stopping: instance.state === 'published',
      group: '公開状態',
      status: instance.state === 'published' ? '公開中' : '準備中',
      reason: instance.pauseReason,
    },
    {
      action: instance.rankedPauseReason ? 'resumeRanked' : 'stopRanked',
      title: instance.rankedPauseReason ? 'ランクを再開する' : 'ランクを停止する',
      stopping: !instance.rankedPauseReason,
      group: '対戦の停止・再開',
      status: `ランク：${instance.rankedPauseReason ? '停止中' : '受付中'}`,
      reason: instance.rankedPauseReason,
    },
    {
      action: instance.casualPauseReason ? 'resumeCasual' : 'stopCasual',
      title: instance.casualPauseReason ? 'カジュアルを再開する' : 'カジュアルを停止する',
      stopping: !instance.casualPauseReason,
      group: '',
      status: `カジュアル：${instance.casualPauseReason ? '停止中' : '受付中'}`,
      reason: instance.casualPauseReason,
    },
  ];
  return (
    <section className="my-5 grid gap-4">
      {actions.map((item) => (
        <div key={item.action}>
          {item.group && <h3 className="mb-2 font-bold">{item.group}</h3>}
          <p>{item.status}</p>
          {item.reason && <p>理由：{item.reason}</p>}
          <Button
            disabled={mutation.busy || mutation.uncertain}
            onClick={() => {
              setSelected({ ...item, revision: instance.operationRevision ?? 0 });
              setReason('');
              setOpen(true);
            }}
          >
            {item.title}
          </Button>
        </div>
      ))}
      <p>
        準備中は一般ユーザーの対戦・作問を休止します。個別停止は対象の対戦だけを止め、全体休止・再公開後も設定を保持します。開始済みの試合は継続します。
      </p>
      {mutation.uncertain && !open && (
        <Button onClick={() => setOpen(true)}>保存結果を確認する</Button>
      )}
      {mutation.error && !open && <p role="alert">{mutation.error}</p>}
      {open && selected && (
        <Modal title={selected.title} busy={mutation.busy} onClose={() => setOpen(false)}>
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void mutation.submit({
                id: instance.id,
                action: selected.action,
                revision: selected.revision,
                reason,
              });
            }}
          >
            <p>
              {instance.name}：{selected.title}
            </p>
            {selected.stopping && (
              <TextField
                id="instance-pause-reason"
                label="利用者向けの停止理由"
                placeholder="例：問題の点検のため"
                required
                maxLength={1000}
                value={reason}
                disabled={mutation.busy || mutation.uncertain}
                onChange={(event) => setReason(event.target.value)}
              />
            )}
            {mutation.error && <p role="alert">{mutation.error}</p>}
            {mutation.uncertain && (
              <p>保存結果を確認できません。同じ内容で再試行してください。</p>
            )}
            <Button type="submit" disabled={mutation.busy}>
              {mutation.uncertain ? '同じ内容で再試行' : selected.title}
            </Button>
          </form>
        </Modal>
      )}
    </section>
  );
}
