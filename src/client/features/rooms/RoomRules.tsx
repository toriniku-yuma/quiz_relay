import type { RoomSettings } from '../../../shared/rooms';
export default function RoomRules({ settings }: { settings: RoomSettings }) {
  return (
    <div className="my-3 grid gap-1 text-sm">
      <p>
        回答者2〜{settings.capacity}人 ／ 部屋主：
        {settings.presenter ? '出題専任' : '回答兼任'}
      </p>
      <p>
        {settings.winMode === 'target'
          ? `${settings.count}問先取`
          : `${settings.count}問で競う`}{' '}
        ／{' '}
        {settings.mistakes === null ? '失格なし' : `お手つき${settings.mistakes}回で失格`}
      </p>
      <p>
        {settings.source === 'original'
          ? '持込問題だけで出題'
          : `通常問題 ／ 難易度 ${settings.difficulties.map((d) => ['易', '中', '難'][d]).join('・')}`}{' '}
        ／ レート対象外
      </p>
      <p>
        {settings.guests
          ? 'ゲスト参加可（インスタンスの許可に従います）'
          : 'ログインしたユーザーのみ'}
      </p>
    </div>
  );
}
