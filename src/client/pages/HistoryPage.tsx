import { useApp } from '../app/context';
import { GAME_PATH } from '../app/paths';
import PageHeader from '../components/PageHeader';
import ForeignHistoryPanel from '../features/federation/ForeignHistoryPanel';
import ResultsPanel from '../features/results/ResultsPanel';

export default function HistoryPage() {
  const { url, organization, auth, foreignLogin } = useApp();
  const foreign = !auth.user ? foreignLogin?.data : null;
  const instanceId = url.searchParams.get('instance') ?? '';
  const organizationId = organization.data?.organization?.id;
  const external =
    url.searchParams.get('external') === '1' || instanceId === organizationId;
  return (
    <main className="mx-auto max-w-5xl p-5 sm:p-8">
      <PageHeader
        title="対戦履歴"
        description="参加した試合の結果と出題済み問題を確認できます。"
      />
      {foreign ? (
        <p className="my-4">
          対戦履歴は所属元に保存されます。
          <a
            className="underline"
            href={`${foreign.account.homeOrigin}/history/?external=1`}
            target="_blank"
            rel="noopener"
          >
            {foreign.account.organizationName}で自分の履歴を見る
          </a>
        </p>
      ) : external ? null : instanceId ? (
        <ResultsPanel
          instanceId={instanceId}
          resultId={url.searchParams.get('result') ?? ''}
        />
      ) : (
        <a className="underline" href={GAME_PATH}>
          インスタンスを選ぶ
        </a>
      )}
      {organizationId && <ForeignHistoryPanel />}
    </main>
  );
}
