import { useApp } from '../../app/context';
import { HISTORY_PATH } from '../../app/paths';

export default function ResultLinks({
  instanceId,
  matchId,
}: {
  instanceId: string;
  matchId: string;
}) {
  const { auth, url } = useApp();
  if ((url.searchParams.get('instance') ?? '') !== instanceId) return null;
  const params = new URLSearchParams({ instance: instanceId });
  if (!auth.user) params.set('guest', '1');
  const href = `${HISTORY_PATH}?${params}`;
  return (
    <div className="my-4 flex flex-wrap gap-4">
      <a className="underline" href={`${href}&result=${matchId}`}>
        試合の詳細
      </a>
      <a className="underline" href={href}>
        対戦履歴
      </a>
    </div>
  );
}
