import type { InputHTMLAttributes } from 'react';
import { cn } from '../lib/cn';

type Props = InputHTMLAttributes<HTMLInputElement> & { id: string; label: string };

export default function TextField({ id, label, className = '', ...props }: Props) {
  return (
    <div className="my-5 grid gap-2">
      <label className="font-semibold" htmlFor={id}>
        {label}
      </label>

      <input
        {...props}
        id={id}
        className={cn(
          'w-full rounded-none border border-line bg-input p-3 text-ink',
          className,
        )}
      />
    </div>
  );
}
