import type { ReactNode } from 'react';
import { useMenuPopover } from '../app/useMenuPopover';
import Button from './Button';

export default function MenuPopover({
  title,
  children,
  upward = false,
}: {
  title: string;
  children: ReactNode;
  upward?: boolean;
}) {
  const { id, trigger, panel, position } = useMenuPopover(upward);
  const Trigger = upward ? Button : 'button';
  return (
    <div>
      <Trigger
        ref={trigger}
        type="button"
        popoverTarget={id}
        onClick={position}
        className={`flex w-full items-center justify-between gap-3 px-5 py-3 text-left text-base font-bold ${upward ? '' : 'rounded border border-line/50 bg-paper'}`}
      >
        <span className="min-w-0 break-words">{title}</span>
        {!upward && (
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            className="size-4 shrink-0"
          >
            <path d="m6 9 6 6 6-6" />
          </svg>
        )}
      </Trigger>
      <section
        ref={panel}
        id={id}
        popover="auto"
        aria-label={title}
        className="fixed m-0 menu-scrollbar overflow-y-auto overscroll-contain rounded-lg border border-line/20 bg-paper p-2 text-base text-ink shadow-lg"
      >
        {children}
      </section>
    </div>
  );
}
