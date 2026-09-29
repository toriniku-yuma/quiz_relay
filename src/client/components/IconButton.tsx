import type { ComponentPropsWithoutRef } from 'react';
import { cn } from '../lib/cn';
export default function IconButton({
  icon,
  label,
  className,
  ...props
}: ComponentPropsWithoutRef<'button'> & {
  icon: 'ban' | 'wrench' | 'report';
  label: string;
}) {
  return (
    <button
      {...props}
      type="button"
      aria-label={label}
      title={label}
      className={cn(
        'inline-flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-full transition-colors motion-reduce:transition-none hover:bg-key focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-45',
        icon === 'ban' ? 'text-accent' : 'text-ink',
        className,
      )}
    >
      <svg
        width="22"
        height="22"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        {icon === 'ban' ? (
          <>
            <circle cx="12" cy="12" r="9" />
            <path d="m6 6 12 12" />
          </>
        ) : icon === 'wrench' ? (
          <path d="M14 6a6 6 0 0 0-7 7L2 18a3 3 0 0 0 4 4l5-5a6 6 0 0 0 7-7l-4 4-4-4 4-4Z" />
        ) : (
          <>
            <path d="M5 22V3m0 0h14l-3 5 3 5H5" />
            <path d="M10 5v3m0 2v.1" />
          </>
        )}
      </svg>
    </button>
  );
}
