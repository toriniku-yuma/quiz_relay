import { type ReactNode, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import Button from './Button';
export default function Modal({
  title,
  children,
  onClose,
  busy = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  busy?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return createPortal(
    <dialog
      ref={ref}
      aria-label={title}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
      className="m-auto max-h-[90dvh] w-full max-w-5xl overflow-y-auto rounded border border-line bg-paper p-5 text-ink backdrop:bg-black/40"
    >
      <header className="mb-5 flex items-center justify-between gap-3">
        <h2 className="text-xl font-bold">{title}</h2>
        <Button className="shrink-0 whitespace-nowrap" disabled={busy} onClick={onClose}>
          閉じる
        </Button>
      </header>
      {children}
    </dialog>,
    document.body,
  );
}
