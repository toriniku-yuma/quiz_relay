import type { ModeratedUser } from '../../../shared/moderation';
import Button from '../../components/Button';
import IconButton from '../../components/IconButton';
import Modal from '../../components/Modal';
import SanctionEditor from './SanctionEditor';
import UserPermissions from './UserPermissions';
import { useUserActions } from './useUserActions';
export default function UserActions({
  user,
  instanceId,
  administrator,
  saved,
}: {
  user: ModeratedUser;
  instanceId: string | null;
  administrator: boolean;
  saved: () => Promise<void>;
}) {
  const model = useUserActions(instanceId, user.actorId, saved),
    close = () => model.setOpen('');
  return (
    <div className="flex items-center gap-1">
      <IconButton
        icon="ban"
        label={`${user.name}の処分を設定`}
        onClick={() => void model.show('sanction')}
      />
      {administrator && (
        <IconButton
          icon="wrench"
          label={`${user.name}の権限を設定`}
          onClick={() => void model.show('permissions')}
        />
      )}
      {model.open && !model.data && (
        <Modal title={user.name} onClose={close}>
          {model.error ? (
            <>
              <p role="alert">{model.error}</p>
              <Button onClick={model.load}>再試行</Button>
            </>
          ) : (
            <p role="status">読み込んでいます。</p>
          )}
        </Modal>
      )}
      {model.data && (
        <>
          <SanctionEditor
            data={model.data}
            loadError={model.error}
            loading={model.busy}
            reload={model.load}
            instanceId={instanceId}
            saved={model.refresh}
            open={model.open === 'sanction'}
            onClose={close}
          />
          <UserPermissions
            user={user}
            instanceId={instanceId}
            open={model.open === 'permissions'}
            onClose={close}
            saved={model.refresh}
          />
        </>
      )}
    </div>
  );
}
