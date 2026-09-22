import { expect, it, vi } from 'vitest';
import { gameHref, handleNavigation, isAppUrl } from '../src/client/app/navigation';

it('same-tab navigation stays within application pages and preserves instance/view values', () => {
  const current = new URL('https://quiz.example/game/');
  expect(isAppUrl(new URL('/debug/?instance=a', current), current)).toBe(true);
  expect(isAppUrl(new URL('/local-game', current), current)).toBe(true);
  expect(isAppUrl(new URL('https://other.example/game/'), current)).toBe(false);
  expect(isAppUrl(new URL('/api/auth/logout', current), current)).toBe(false);
  expect(isAppUrl(new URL('/unknown/', current), current)).toBe(false);
  const instance = 'test&view=organization#fragment';
  const url = new URL(gameHref(instance, 'history'), current);
  expect(url.pathname).toBe('/game/');
  expect(url.searchParams.get('instance')).toBe(instance);
  expect(url.searchParams.get('view')).toBe('history');
  expect(url.hash).toBe('');
  expect(gameHref()).toBe('/game/');
});

it('instance switches request menu retention, while page links close it and modified clicks remain native', () => {
  class Link {
    href = 'https://quiz.example/game/?instance=next';
    target = '';
    instanceSwitch = true;
    closest() {
      return this;
    }
    hasAttribute(name: string) {
      return name === 'data-instance-switch' && this.instanceSwitch;
    }
  }
  const dispatch = vi.fn();
  const push = vi.fn();
  vi.stubGlobal('Element', Link);
  vi.stubGlobal('HTMLAnchorElement', Link);
  vi.stubGlobal('document', { dispatchEvent: dispatch, querySelectorAll: () => [] });
  vi.stubGlobal('window', { dispatchEvent: vi.fn() });
  vi.stubGlobal('history', { pushState: push });
  vi.stubGlobal('location', { href: 'https://quiz.example/game/' });
  vi.stubGlobal('PopStateEvent', Event);
  vi.stubGlobal(
    'CustomEvent',
    class extends Event {
      detail: unknown;
      constructor(type: string, options: { detail: unknown }) {
        super(type);
        this.detail = options.detail;
      }
    },
  );
  const link = new Link();
  const event = { target: link, button: 0, preventDefault: vi.fn() };
  try {
    handleNavigation(event as unknown as MouseEvent);
    expect(dispatch.mock.calls[0][0].detail).toEqual({
      keepMenuOpen: true,
      href: link.href,
    });
    link.instanceSwitch = false;
    handleNavigation(event as unknown as MouseEvent);
    expect(dispatch.mock.calls[1][0].detail.keepMenuOpen).toBe(false);
    handleNavigation({ ...event, ctrlKey: true } as unknown as MouseEvent);
    expect(push).toHaveBeenCalledTimes(2);
  } finally {
    vi.unstubAllGlobals();
  }
});
