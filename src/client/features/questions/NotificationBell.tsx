import Button from '../../components/Button';
import { questionHref } from './pages';
import { useNotifications } from './useNotifications';

export default function NotificationBell() {
  const model = useNotifications();
  return (
    <>
      <button
        type="button"
        aria-label={`通知${model.unread ? `（未読${model.unread}件）` : ''}`}
        aria-haspopup="dialog"
        aria-expanded={model.opened}
        onClick={model.open}
        className="relative ml-auto rounded p-3 hover:bg-key"
      >
        <svg
          aria-hidden="true"
          width="24"
          height="24"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" />
        </svg>
        {model.unread > 0 && (
          <span
            aria-hidden="true"
            className="absolute right-1 top-0 rounded-full bg-accent px-1 text-xs font-bold"
          >
            {model.unread}
          </span>
        )}
      </button>
      <dialog
        ref={model.dialog}
        aria-labelledby="notification-title"
        onCancel={(event) => {
          event.preventDefault();
          model.close();
        }}
        className="fixed inset-y-0 left-0 m-0 h-dvh max-h-none w-80 max-w-[90vw] overflow-y-auto border-r border-line bg-paper p-5 text-ink backdrop:bg-black/30 lg:inset-auto lg:right-4 lg:top-16 lg:h-auto lg:max-h-[80dvh] lg:w-96 lg:rounded-lg lg:border lg:shadow-xl"
      >
        <div className="flex items-center justify-between gap-4">
          <h2 id="notification-title" className="text-xl font-bold">
            通知
          </h2>
          <Button onClick={model.close}>閉じる</Button>
        </div>
        <p className="my-3 text-sm text-muted">最新5件</p>
        {model.loading ? (
          <p role="status">読み込んでいます。</p>
        ) : (
          <>
            {model.error && <p role="alert">{model.error}</p>}
            {!model.rows.length && !model.error && <p>通知はありません。</p>}
            <ul className="grid gap-3">
              {model.rows.map((row) => (
                <li key={row.id} className="border-b border-line pb-3">
                  <a
                    className="block rounded p-2 hover:bg-key focus:bg-key"
                    href={questionHref(
                      row.target?.page ?? 'mine',
                      row.instanceId,
                      row.target?.id,
                    )}
                    onClick={model.close}
                  >
                    <span className="block text-sm text-muted">
                      {model.instances.find((item) => item.id === row.instanceId)?.name}
                    </span>
                    <span className="block whitespace-pre-wrap break-words underline">
                      {row.message}
                    </span>
                    <time
                      className="mt-2 block text-sm text-muted"
                      dateTime={row.createdAt}
                    >
                      {new Date(row.createdAt).toLocaleString()}
                    </time>
                  </a>
                </li>
              ))}
            </ul>
          </>
        )}
      </dialog>
    </>
  );
}
