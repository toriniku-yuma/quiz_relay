import { DEBUG_PATH } from '../app/paths';

export default function NotFoundPage() {
  return (
    <main className="mx-auto max-w-7xl px-4 pt-6 pb-10 sm:px-8 sm:pt-10 sm:pb-16">
      <h1 className="text-3xl leading-tight tracking-tight sm:text-5xl">
        ページが見つかりません
      </h1>

      <a href={DEBUG_PATH}>動作検証へ戻る</a>
    </main>
  );
}
