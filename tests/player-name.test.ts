import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import PlayerName from '../src/client/components/PlayerName';

it('同じユーザー名でも所属サーバー名を別の小さい表示で区別する', () => {
  for (const serverName of ['連携検証 A', '連携検証 B']) {
    const player = { name: '同名ユーザー', serverName };
    const html = renderToStaticMarkup(createElement(PlayerName, { player }));
    expect(html).toContain('同名ユーザー<small');
    expect(html).toContain(`（${serverName}）</small>`);
    expect(player.name).toBe('同名ユーザー');
  }
});
