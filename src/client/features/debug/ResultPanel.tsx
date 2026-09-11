import Panel from '../../components/Panel';

export default function ResultPanel({
  busy,
  result,
}: {
  busy: boolean;
  result: unknown;
}) {
  return (
    <Panel title="実行結果">
      <pre
        className="mt-4 whitespace-pre-wrap border border-line bg-result p-4 text-sm wrap-anywhere"
        aria-live="polite"
      >
        {busy
          ? '実行中…'
          : typeof result === 'string'
            ? result
            : JSON.stringify(result, null, 2)}
      </pre>
    </Panel>
  );
}
