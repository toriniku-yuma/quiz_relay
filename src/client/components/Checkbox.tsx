import { type ComponentPropsWithoutRef, useEffect, useRef } from 'react';
import { cn } from '../lib/cn';
export default function Checkbox({
  mixed = false,
  className,
  ...props
}: Omit<ComponentPropsWithoutRef<'input'>, 'type'> & { mixed?: boolean }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = mixed;
  }, [mixed]);
  return (
    <input
      {...props}
      ref={ref}
      type="checkbox"
      aria-checked={mixed ? 'mixed' : props.checked}
      className={cn(
        'size-6 shrink-0 cursor-pointer align-middle accent-accent focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed',
        className,
      )}
    />
  );
}
