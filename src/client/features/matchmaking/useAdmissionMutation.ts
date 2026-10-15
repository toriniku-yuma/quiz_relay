import { useRef, useState } from 'react';
import { API_PATHS } from '../../../shared/api-paths';
import { useMutation } from '../moderation/useMutation';
import { PlayRequestError, playRequest } from '../rooms/api';

export function useAdmissionMutation(
  path: string,
  onSaved: (request: Record<string, unknown>) => void | Promise<void>,
  send: (path: string, body: object) => Promise<unknown>,
) {
  const [conflict, setConflict] = useState<{
    room: string;
    instanceId: string;
    mode: 'ranked' | 'casual' | 'room';
  } | null>(null);
  const rejected = useRef<Record<string, unknown> | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [leaveError, setLeaveError] = useState('');
  const mutation = useMutation(path, onSaved, async (path, body) => {
    try {
      return await send(path, body);
    } catch (error) {
      if (
        error instanceof PlayRequestError &&
        ['ALREADY_JOINED', 'OTHER_INSTANCE_ACTIVE'].includes(error.code) &&
        error.room &&
        error.instanceId &&
        error.mode
      ) {
        rejected.current = body as Record<string, unknown>;
        setConflict({ room: error.room, instanceId: error.instanceId, mode: error.mode });
      }
      throw error;
    }
  });
  return {
    ...mutation,
    busy: mutation.busy || leaving,
    error: leaveError || mutation.error,
    conflict,
    dismissConflict: () => setConflict(null),
    leaveAndJoin: async () => {
      if (!conflict || !rejected.current || leaving) return;
      setLeaving(true);
      setLeaveError('');
      try {
        const path =
          conflict.mode === 'ranked'
            ? API_PATHS.matchCancel
            : conflict.mode === 'casual'
              ? API_PATHS.casualCancel
              : API_PATHS.roomLeave;
        await playRequest(
          path,
          {
            room: conflict.room,
            ...(conflict.mode === 'room' ? { force: true } : { forfeit: true }),
          },
          conflict.instanceId,
        );
        setConflict(null);
        await mutation.submit(rejected.current);
      } catch (error) {
        setLeaveError(
          error instanceof Error ? error.message : '離脱を確認できませんでした。',
        );
      } finally {
        setLeaving(false);
      }
    },
  };
}
