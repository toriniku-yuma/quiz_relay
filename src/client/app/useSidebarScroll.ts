import { useEffect, useRef } from 'react';

export function useSidebarScroll() {
  const nav = useRef<HTMLElement>(null);
  useEffect(() => {
    const element = nav.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      if (event.ctrlKey || !event.deltaY) return;
      if (event.target instanceof Element && event.target.closest('[popover]')) return;
      const area = element.querySelector<HTMLElement>('[data-sidebar-scroll]');
      if (!area) return;
      const unit =
        event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? area.clientHeight : 1;
      event.preventDefault();
      area.scrollTop += event.deltaY * unit;
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  }, []);
  return nav;
}
