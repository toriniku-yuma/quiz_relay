import PageHeader from '../components/PageHeader';
import AuthPanel from '../features/auth/AuthPanel';
import ConnectionPanel from '../features/debug/ConnectionPanel';
import ResultPanel from '../features/debug/ResultPanel';
import { useDebug } from '../features/debug/useDebug';

export default function DebugPage() {
  const debug = useDebug();

  return (
    <main className="mx-auto max-w-4xl px-4 pt-6 pb-10 sm:px-8 sm:pt-10 sm:pb-16">
      <PageHeader
        title="開発基盤の検証"
        description="接続・保存・署名・認証を個別に確認する開発用ページです。"
      />

      <ConnectionPanel debug={debug} />
      <AuthPanel debug={debug} />
      <ResultPanel busy={debug.busy} result={debug.result} />
    </main>
  );
}
