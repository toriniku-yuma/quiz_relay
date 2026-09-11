import type { ComponentPropsWithRef } from 'react';
import { cn } from '../lib/cn';

type Props = ComponentPropsWithRef<'button'> & {
  tone?: 'primary' | 'neutral';
};

const tones = {
  primary: 'border-edge bg-accent text-on-accent',
  neutral: 'border-line bg-key text-ink',
} as const;

export default function Button({
  tone = 'neutral',
  className = '',
  type = 'button',
  ...props
}: Props) {
  return (
    <button
      {...props}
      type={type}
      data-tone={tone}
      className={cn(
        'inline-flex min-h-12 cursor-pointer items-center justify-center rounded-sm border px-4 py-2.5 text-sm font-semibold',
        'shadow-button enabled:hover:underline enabled:hover:underline-offset-4 enabled:active:translate-y-0.5 enabled:active:shadow-button-pressed disabled:cursor-not-allowed disabled:opacity-45',
        tones[tone],
        className,
      )}
    />
  );
}
