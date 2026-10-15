import { CASUAL_PATH, GAME_PATH, ROOMS_PATH } from '../../app/paths';
import Button from '../../components/Button';
import Modal from '../../components/Modal';

export default function ParticipationConflict({
  conflict,
  busy,
  onClose,
  onLeave,
}: {
  conflict: { room: string; instanceId: string; mode: 'ranked' | 'casual' | 'room' };
  busy: boolean;
  onClose: () => void;
  onLeave: () => Promise<void>;
}) {
  const path =
    conflict.mode === 'ranked'
      ? GAME_PATH
      : conflict.mode === 'casual'
        ? CASUAL_PATH
        : ROOMS_PATH;
  const query = new URLSearchParams({ instance: conflict.instanceId });
  if (conflict.mode === 'room') query.set('room', conflict.room);
  return (
    <Modal title="参加中の試合・部屋があります" onClose={onClose}>
      <p className="my-3">
        新しく参加するには、先に現在の参加を終了してください。開始済みの試合から離れると棄権になります。
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <a className="underline" href={`${path}?${query}`} onClick={onClose}>
          元の参加へ戻る
        </a>
        <Button disabled={busy} onClick={onLeave}>
          離脱して新しい参加を行う
        </Button>
      </div>
    </Modal>
  );
}
