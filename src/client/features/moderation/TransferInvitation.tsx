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
    <tr>
      <td>
        {invite.senderName} → {invite.targetName}
      </td>
      <td>
        {invite.state === 'accepted'
          ? '引き継ぎ済み'
          : invite.state === 'cancelled'
            ? '取り消し済み'
            : pending
              ? '承諾待ち'
              : '期限切れ'}
      </td>
      <td>{invite.keepSender ? '管理者として残る' : '管理者から外れる'}</td>
      <td className="whitespace-nowrap">{new Date(invite.expiresAt).toLocaleString()}</td>
      <td>
        <div className="grid gap-3">
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
          {!pending && !mutation.error && !mutation.uncertain && '—'}
        </div>
      </td>
    </tr>
  );
}
