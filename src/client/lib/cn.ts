import { type ClassValue, clsx } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

const mergeClasses = extendTailwindMerge({
  extend: {
    theme: {
      shadow: ['button', 'button-pressed'],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return mergeClasses(clsx(inputs));
}
