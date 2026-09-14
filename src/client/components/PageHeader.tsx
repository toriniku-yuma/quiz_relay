import { DEBUG_PATH, GAME_PATH, LOCAL_GAME_PATH } from '../app/paths';

type Props = { title: string; description: string };

export default function PageHeader({ title, description }: Props) {
  return (
    <header className="mb-8 flex flex-col gap-4 sm:flex-row sm:flex-wrap sm:items-baseline sm:gap-6 border-b-2 border-ink pb-8">
      <a className="font-extrabold tracking-widest no-underline" href={GAME_PATH}>
        QUIZ RELAY
      </a>

      <nav className="flex gap-5 text-sm sm:ml-auto" aria-label="ページ">
        <a href={GAME_PATH}>対戦</a>
        {import.meta.env.DEV && <a href={LOCAL_GAME_PATH}>ローカル検証</a>}
        <a href={DEBUG_PATH}>動作検証</a>
      </nav>

      <h1 className="w-full text-3xl leading-tight tracking-tight sm:text-5xl">
        {title}
      </h1>

      <p className="w-full max-w-2xl text-muted">{description}</p>
    </header>
  );
}
