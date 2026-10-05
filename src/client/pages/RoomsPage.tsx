import { useApp } from '../app/context';
import PageHeader from '../components/PageHeader';
import RoomWorkspace from '../features/rooms/RoomWorkspace';
export default function RoomsPage() {
  const { auth, url } = useApp();
  return (
    <main className="mx-auto max-w-5xl p-4 md:p-8">
      <PageHeader
        title={url.searchParams.get('view') === 'game' ? '部屋の対戦' : '部屋マッチ'}
        description={
          url.searchParams.get('view') === 'game'
            ? '早押しして回答しましょう。'
            : '部屋を選び、ルールを確認して参加できます。'
        }
      />
      {auth.ready ? (
        <RoomWorkspace />
      ) : (
        <p role="status">ログイン状態を確認しています。</p>
      )}
    </main>
  );
}
