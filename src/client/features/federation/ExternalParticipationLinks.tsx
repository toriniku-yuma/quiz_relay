import type { ExternalInstanceDirectory } from '../../../shared/federation';
import { participationOrigin } from '../../../shared/participation';
import { foreignPlayPath } from './redirect';

export default function ExternalParticipationLinks({
  instance,
  organizationId,
}: {
  instance: ExternalInstanceDirectory['instances'][number];
  organizationId: string;
}) {
  const home = location.origin;
  function href(mode: 'ranked' | 'casual' | 'room') {
    return `${instance.peerOrigin}${foreignPlayPath(mode)}?${new URLSearchParams({
      home,
      source: organizationId,
      instance: instance.instanceId,
      mode,
    })}`;
  }
  return (
    <div className="my-5 grid gap-3">
      {participationOrigin(home) ? (
        <div className="flex flex-wrap gap-4">
          {instance.ranked && (
            <a className="underline" href={href('ranked')} target="_blank" rel="noopener">
              開催先のランクを開く
            </a>
          )}
          {instance.casual && (
            <>
              <a
                className="underline"
                href={href('casual')}
                target="_blank"
                rel="noopener"
              >
                開催先のカジュアルを開く
              </a>
              <a className="underline" href={href('room')} target="_blank" rel="noopener">
                開催先の部屋を開く
              </a>
            </>
          )}
        </div>
      ) : (
        <p>外部参加は、所属元の公開サーバーから開始してください。</p>
      )}
      <p className="text-sm">
        開催先は別タブで開き、所属元でログイン済みなら自動ログインします。対戦には開催先の参加ボタンで入ります。
      </p>
    </div>
  );
}
