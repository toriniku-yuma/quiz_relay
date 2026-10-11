import { useApp } from '../app/context';
import Button from '../components/Button';
import PageHeader from '../components/PageHeader';
import QuestionImports from '../features/federation/QuestionImports';
import { useQuestionSharing } from '../features/federation/useQuestionSharing';

export default function QuestionSharingPage() {
  const { organization, url } = useApp(),
    instanceId = url.searchParams.get('instance') ?? '',
    instance = organization.data?.instances.find(
      (instance) => instance.id === instanceId,
    ),
    actorId = organization.data?.account?.actorId ?? '';
  const allowed =
    !!instance &&
    (organization.data?.account?.administrator === true ||
      instance.permissions.includes('questions'));
  const sharing = useQuestionSharing(instanceId, actorId, allowed);
  return (
    <main className="mx-auto grid max-w-5xl gap-5 p-4 md:p-8">
      <PageHeader
        title="共有問題"
        description="他のインスタンスから受け取る問題と、その分類先を設定します。"
      />
      {instance && <p>{instance.name}</p>}
      {!allowed ? (
        <p>組織管理者・このインスタンスの作問管理担当が利用できます。</p>
      ) : (
        <>
          {sharing.error && (
            <p role="alert" className="border border-accent p-3">
              {sharing.error}
            </p>
          )}
          {sharing.loadFailed && (
            <Button disabled={sharing.busy} onClick={sharing.refresh}>
              再試行
            </Button>
          )}
          {!sharing.data ? (
            <p role="status">
              {sharing.loadFailed
                ? '共有設定を取得できませんでした。'
                : '共有設定を読み込んでいます。'}
            </p>
          ) : (
            <QuestionImports sharing={sharing} />
          )}
        </>
      )}
    </main>
  );
}
