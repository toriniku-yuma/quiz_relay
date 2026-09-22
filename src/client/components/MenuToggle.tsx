type Props = { expanded: boolean; onClick: () => void };

export default function MenuToggle({ expanded, onClick }: Props) {
  const line =
    'absolute left-2.5 h-0.5 w-6 rounded bg-current transition-[transform,opacity] duration-200 motion-reduce:transition-none';
  return (
    <button
      type="button"
      aria-label={expanded ? 'メニューを閉じる' : 'メニューを開く'}
      aria-expanded={expanded}
      aria-controls="mobile-menu"
      aria-haspopup="dialog"
      onClick={onClick}
      className="relative flex size-11 shrink-0 items-center justify-center rounded-lg hover:bg-key active:bg-key"
    >
      <span
        aria-hidden="true"
        className={line}
        style={{ transform: expanded ? 'rotate(45deg)' : 'translateY(-7px)' }}
      />
      <span aria-hidden="true" className={line} style={{ opacity: expanded ? 0 : 1 }} />
      <span
        aria-hidden="true"
        className={line}
        style={{ transform: expanded ? 'rotate(-45deg)' : 'translateY(7px)' }}
      />
    </button>
  );
}
