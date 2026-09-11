import type { ReactNode } from 'react';

type Props = { title: string; children: ReactNode };

export default function Panel({ title, children }: Props) {
  return (
    <section className="mt-6 border border-line bg-surface p-4 sm:p-6">
      <h2 className="text-xl font-bold">{title}</h2>

      {children}
    </section>
  );
}
