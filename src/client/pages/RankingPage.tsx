import { useApp } from '../app/context';
import { GAME_PATH } from '../app/paths';
import PageHeader from '../components/PageHeader';
import ResultsPanel from '../features/results/ResultsPanel';

export default function RankingPage() {
  const { auth, url } = useApp();
  const instanceId = url.searchParams.get('instance') ?? '';
  return (
    <main className="mx-auto max-w-5xl p-5 sm:p-8">
      <PageHeader
        title="ランキング"
        description="このインスタンスのランクマッチのレートを表示します。"
      />
      {auth.user && instanceId ? (
        <ResultsPanel section="ranking" instanceId={instanceId} />
      ) : (
        <a className="underline" href={GAME_PATH}>
          インスタンスを選ぶ
        </a>
      )}
    </main>
  );
}
