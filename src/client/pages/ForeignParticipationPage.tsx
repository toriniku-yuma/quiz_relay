import PageHeader from '../components/PageHeader';

export default function ForeignParticipationPage() {
  return (
    <main className="mx-auto max-w-4xl p-8">
      <PageHeader
        title="対戦画面へ移動しています"
        description="開催先の通常画面へ戻ります。"
      />
      <p role="status">通常の対戦画面でログイン状態を確認します。</p>
    </main>
  );
}
