import { useCallback, useEffect, useRef, useState } from 'react';

const duration = () => (matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 180);

export function useMobileMenu(href: string) {
  const dialog = useRef<HTMLDialogElement>(null);
  const animation = useRef<Animation | null>(null);
  const frame = useRef(0);
  const keepOpen = useRef<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  const close = useCallback((focusPage = false) => {
    cancelAnimationFrame(frame.current);
    const element = dialog.current;
    if (!element?.open) return;
    for (const popup of element.querySelectorAll<HTMLElement>('[popover]:popover-open'))
      popup.hidePopover();
    animation.current?.cancel();
    setExpanded(false);
    const closing = element.animate(
      [{ transform: 'translateX(0)' }, { transform: 'translateX(-100%)' }],
      { duration: duration(), easing: 'ease-in' },
    );
    animation.current = closing;
    void closing.finished
      .then(() => {
        element.close();
        if (focusPage)
          document
            .querySelector<HTMLElement>('[data-page]:not([hidden]) h1')
            ?.focus({ preventScroll: true });
      })
      .catch(() => {});
  }, []);

  const open = () => {
    const element = dialog.current;
    if (!element) return;
    animation.current?.cancel();
    element.showModal();
    animation.current = element.animate(
      [{ transform: 'translateX(-100%)' }, { transform: 'translateX(0)' }],
      { duration: duration(), easing: 'ease-out' },
    );
    frame.current = requestAnimationFrame(() => setExpanded(true));
  };

  useEffect(() => {
    const onNavigation = (event: Event) => {
      const detail = (event as CustomEvent<{ keepMenuOpen: boolean; href: string }>)
        .detail;
      keepOpen.current = detail.keepMenuOpen ? detail.href : null;
      if (!keepOpen.current) close(true);
    };
    const desktop = matchMedia('(min-width: 64rem)');
    const onResize = () => {
      if (desktop.matches) close();
    };
    document.addEventListener('app:navigate', onNavigation);
    desktop.addEventListener('change', onResize);
    return () => {
      document.removeEventListener('app:navigate', onNavigation);
      desktop.removeEventListener('change', onResize);
      cancelAnimationFrame(frame.current);
      animation.current?.cancel();
    };
  }, [close]);

  useEffect(() => {
    if (!href) return;
    if (keepOpen.current !== href) close(true);
    keepOpen.current = null;
  }, [href, close]);

  return { dialog, expanded, open, close };
}
