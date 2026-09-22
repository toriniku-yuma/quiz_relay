import { GAME_PATH } from '../app/paths';

export default function NotFoundPage() {
  return (
    <main className="mx-auto max-w-7xl px-4 pt-6 pb-10 sm:px-8 sm:pt-10 sm:pb-16">
      <h1
        tabIndex={-1}
        className="outline-none text-3xl leading-tight tracking-tight sm:text-5xl"
      >
        ページが見つかりません
      </h1>

      <a href={GAME_PATH}>インスタンス一覧へ戻る</a>
    </main>
  );
}
