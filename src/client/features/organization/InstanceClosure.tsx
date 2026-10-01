import type { OrganizationOverview } from '../../../shared/organization';
import Button from '../../components/Button';
import Modal from '../../components/Modal';
import QuestionExport from '../questions/QuestionExport';
import { useClosure } from './useClosure';
import type { useOrganization } from './useOrganization';

export default function InstanceClosure({
  instance,
  organization,
}: {
  instance: OrganizationOverview['instances'][number];
  organization: ReturnType<typeof useOrganization>;
}) {
  const model = useClosure(instance.id, organization.refresh);
  const admin = organization.data?.account?.administrator;
  const archived = instance.state === 'archived';
  const request = {
    id: instance.id,
    revision: instance.operationRevision ?? 0,
    action: archived ? 'restore' : 'archive',
  };
  return (
    <section className="grid gap-5">
      <h2 className="text-2xl font-bold">
        {instance.name}：{archived ? 'アーカイブ後の手続き' : '運営を終了する'}
      </h2>
      {archived ? (
        <>
          <p>
            アーカイブ済みです。通常運営は停止しています。作問者は自分の投稿、管理者・問題管理担当は管理対象の問題を出力できます。
          </p>
          <Button disabled={model.busy} onClick={() => void model.exportMine()}>
            自作問題をJSON出力
          </Button>
          {(admin || instance.permissions.includes('questions')) && (
            <Button onClick={() => model.setExportOpen(true)}>
              管理対象の問題をエクスポート
            </Button>
          )}
          {model.files.map((content, index) => (
            <a
              key={content}
              className="underline"
              download={`my-questions-${index + 1}.json`}
              href={`data:application/json;charset=utf-8,${encodeURIComponent(content)}`}
            >
              JSON {index + 1}を保存
            </a>
          ))}
          {admin && (
            <Button disabled={model.mutation.busy} onClick={() => model.setConfirm(true)}>
              運営を再開する
            </Button>
          )}
          {admin && (
            <a className="underline" href={`/game/?view=delete&instance=${instance.id}`}>
              インスタンスを完全に削除する
            </a>
          )}
          {model.confirm && (
            <Modal
              title="運営を再開する"
              busy={model.mutation.busy}
              onClose={() => model.setConfirm(false)}
            >
              <p>
                {instance.name}
                を準備中へ戻します。ランク／カジュアルの個別停止設定は保持します。問題・設定を確認してから公開してください。
              </p>
              <Button
                disabled={model.mutation.busy}
                onClick={() => void model.mutation.submit(request)}
              >
                {model.mutation.uncertain ? '同じ内容で再試行' : '準備中へ戻す'}
              </Button>
            </Modal>
          )}
        </>
      ) : admin ? (
        <>
          <p>
            アーカイブすると新規対戦と通常運営を終了します。問題は削除せず、作問者は自分の投稿、管理者・問題管理担当は管理対象の問題をエクスポートできます。開始済み試合と結果保存は継続します。
          </p>
          <p>アーカイブ後も、管理者は準備中へ戻して運営を再開できます。</p>
          <Button
            disabled={model.mutation.busy}
            onClick={() => void model.mutation.submit(request)}
          >
            {model.mutation.uncertain ? '同じ内容で再試行' : 'アーカイブする'}
          </Button>
        </>
      ) : (
        <p>この操作には管理者の権限が必要です。</p>
      )}
      {(model.error || model.mutation.error) && (
        <p role="alert">{model.error || model.mutation.error}</p>
      )}
      {model.mutation.uncertain && (
        <p>保存結果を確認できません。同じ内容で再試行してください。</p>
      )}
      {model.exportOpen && (
        <QuestionExport
          instanceId={instance.id}
          ids={[]}
          onClose={() => model.setExportOpen(false)}
        />
      )}
      <a className="underline" href={`/game/?view=settings&instance=${instance.id}`}>
        インスタンス設定へ戻る
      </a>
    </section>
  );
}
