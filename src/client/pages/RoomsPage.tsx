import { useApp } from '../app/context';
import PageHeader from '../components/PageHeader';
import RoomWorkspace from '../features/rooms/RoomWorkspace';
export default function RoomsPage() {
  const { auth } = useApp();
  return (
    <main className="mx-auto max-w-5xl p-4 md:p-8">
      <PageHeader
        title="部屋マッチ"
        description="部屋を選び、ルールを確認して参加できます。"
      />
      {auth.ready ? (
        <RoomWorkspace />
      ) : (
        <p role="status">ログイン状態を確認しています。</p>
      )}
    </main>
  );
}
