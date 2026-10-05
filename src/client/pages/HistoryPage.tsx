import { useApp } from '../app/context';
import { GAME_PATH } from '../app/paths';
import PageHeader from '../components/PageHeader';
import ResultsPanel from '../features/results/ResultsPanel';

export default function HistoryPage() {
  const { url, organization } = useApp();
  const instanceId = url.searchParams.get('instance') ?? '';
  return (
    <main className="mx-auto max-w-5xl p-5 sm:p-8">
      <PageHeader
        title="対戦履歴"
        description="参加した試合の結果と出題済み問題を確認できます。"
      />
      {instanceId || organization.data?.enabled === false ? (
        <ResultsPanel
          instanceId={instanceId}
          resultId={url.searchParams.get('result') ?? ''}
        />
      ) : (
        <a className="underline" href={GAME_PATH}>
          インスタンスを選ぶ
        </a>
      )}
    </main>
  );
}
