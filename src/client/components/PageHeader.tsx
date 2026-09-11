import { DEBUG_PATH, GAME_PATH } from '../app/paths';

type Props = { title: string; description: string };

export default function PageHeader({ title, description }: Props) {
  return (
    <header className="mb-8 flex flex-col gap-4 sm:flex-row sm:flex-wrap sm:items-baseline sm:gap-6 border-b-2 border-ink pb-8">
      <a className="font-extrabold tracking-widest no-underline" href={DEBUG_PATH}>
        QUIZ RELAY <span className="ml-2 border px-1 py-0.5 text-xs">LAB</span>
      </a>

      <nav className="flex gap-5 text-sm sm:ml-auto" aria-label="検証ページ">
        <a href={DEBUG_PATH}>動作検証</a>
        <a href={GAME_PATH}>クイズ検証</a>
      </nav>

      <h1 className="w-full text-3xl leading-tight tracking-tight sm:text-5xl">
        {title}
      </h1>

      <p className="w-full max-w-2xl text-muted">{description}</p>
    </header>
  );
}
