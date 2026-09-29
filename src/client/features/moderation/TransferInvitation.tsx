import { API_PATHS } from '../../../shared/api-paths';
import type { Transfer } from '../../../shared/moderation';
import { useApp } from '../../app/context';
import Button from '../../components/Button';
import { useMutation } from './useMutation';
export default function TransferInvitation({ invite }: { invite: Transfer }) {
  const { organization } = useApp(),
    actorId = organization.data?.account?.actorId;
  const mutation = useMutation(API_PATHS.moderationWorkflow, async () => {
    await organization.refresh();
  });
  const pending = invite.state === 'pending' && Date.parse(invite.expiresAt) > Date.now();
  return (
    <div className="grid gap-3 border border-line p-3">
      <p>
        {invite.senderName} → {invite.targetName} /{' '}
        {invite.state === 'accepted'
          ? '引き継ぎ済み'
          : invite.state === 'cancelled'
            ? '取り消し済み'
            : pending
              ? '承諾待ち'
              : '期限切れ'}
      </p>
      <p>
        依頼者は引き継ぎ後
        {invite.keepSender ? 'も管理者として残ります。' : 'に管理者から外れます。'} /
        期限：{new Date(invite.expiresAt).toLocaleString()}
      </p>
      {pending && (
        <Button
          disabled={mutation.busy || mutation.uncertain}
          onClick={() =>
            void mutation.submit({
              action: actorId === invite.targetId ? 'acceptAdmin' : 'cancelAdmin',
              id: invite.id,
            })
          }
        >
          {actorId === invite.targetId ? '管理者引き継ぎを承諾' : '依頼を取り消す'}
        </Button>
      )}
      {mutation.error && <p role="alert">{mutation.error}</p>}
      {mutation.uncertain && (
        <Button disabled={mutation.busy} onClick={() => void mutation.submit({})}>
          同じ内容で再試行
        </Button>
      )}
    </div>
  );
}
