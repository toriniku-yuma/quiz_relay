import { useApp } from '../../app/context';
import Button from '../../components/Button';
import SelfRanking from './SelfRanking';
import { useResults } from './useResults';

export default function MatchingRanking({ instanceId }: { instanceId: string }) {
  const { auth } = useApp();
  const results = useResults(auth.user?.id ?? '', instanceId, {
    section: 'self',
  });
  return (
    <>
      <SelfRanking value={results.data?.self} />
      {results.error && (
        <div className="my-4 flex flex-wrap items-center gap-3">
          <p role="alert">順位・レートを読み込めませんでした。</p>
          <Button disabled={results.busy} onClick={results.retry}>
            再試行
          </Button>
        </div>
      )}
    </>
  );
}
