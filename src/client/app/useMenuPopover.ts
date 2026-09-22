import { useCallback, useEffect, useId, useRef } from 'react';

export function useMenuPopover(upward: boolean) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLElement>(null);
  const position = useCallback(() => {
    const button = trigger.current;
    const popup = panel.current;
    if (!button || !popup) return;
    const rect = button.getBoundingClientRect();
    const width = Math.min(Math.max(rect.width, 240), window.innerWidth - 24);
    const below = window.innerHeight - rect.bottom - 20;
    const above = rect.top - 20;
    const up = upward ? above >= 160 || above > below : below < 160 && above > below;
    Object.assign(popup.style, {
      width: `${width}px`,
      left: `${Math.max(12, Math.min(rect.left, window.innerWidth - width - 12))}px`,
      top: up ? 'auto' : `${rect.bottom + 8}px`,
      bottom: up ? `${window.innerHeight - rect.top + 8}px` : 'auto',
      maxHeight: `${Math.max(80, up ? above : below)}px`,
    });
  }, [upward]);

  useEffect(() => {
    const update = () => {
      if (panel.current?.matches(':popover-open')) position();
    };
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [position]);

  return { id, trigger, panel, position };
}
