type Props = { title: string; description: string };

export default function PageHeader({ title, description }: Props) {
  return (
    <header className="mb-8 grid gap-4 border-b-2 border-ink pb-6">
      <h1
        tabIndex={-1}
        className="outline-none text-3xl leading-tight tracking-tight sm:text-4xl"
      >
        {title}
      </h1>
      <p className="max-w-2xl text-muted">{description}</p>
    </header>
  );
}
