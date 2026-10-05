export default function Spinner() {
  return (
    <span
      role="img"
      aria-label="読み込み中"
      className="block size-12 animate-spin rounded-full border-4 border-line border-t-accent opacity-50 motion-reduce:animate-none"
    />
  );
}
