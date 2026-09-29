import Button from '../../components/Button';
import Checkbox from '../../components/Checkbox';
import DataTable from '../../components/DataTable';
import Pagination from '../../components/Pagination';
import TextField from '../../components/TextField';
import { useInvestigation } from './useInvestigation';

const time = (ms: number | null) =>
  ms === null ? '未記録' : `${(ms / 1000).toFixed(3)}秒`;
export default function Investigation({
  instanceId,
  actorId,
  reportId,
}: {
  instanceId: string | null;
  actorId: string;
  reportId?: string;
}) {
  const m = useInvestigation(instanceId, actorId, reportId),
    d = m.data;
  return (
    <section className="mt-6 grid gap-4 border-t border-line pt-5">
      <h3 className="text-xl font-bold">
        {reportId ? '通報された試合と、それ以前の戦績' : '過去の戦績'}
      </h3>
      <div className="flex flex-wrap items-end gap-3">
        <TextField
          id="history-sample"
          label="平均の集計対象：直近の試合数"
          type="number"
          min="1"
          step="1"
          placeholder="例：30"
          value={m.sample}
          disabled={m.all}
          onChange={(e) => m.setSample(e.target.value)}
        />
        <label className="py-3">
          <Checkbox checked={m.all} onChange={(e) => m.setAll(e.target.checked)} /> 全件
        </label>
      </div>
      <p className="text-sm">
        {reportId ? '通報された試合より前の、' : ''}
        同じインスタンスの戦績です。平均の対象件数と一覧の表示件数は独立しています。早押し時間は解答・判定・中断中を除外します。誤答・時間切れの集計は詳細記録のある試合のみを対象にします。未記録の試合を0秒として扱いません。
      </p>
      {m.error && (
        <>
          <p role="alert">{m.error}</p>
          <Button onClick={m.retry}>再試行</Button>
        </>
      )}
      {m.busy && (
        <p role="status" className={d ? 'sr-only' : undefined}>
          戦績を取得しています。
        </p>
      )}
      {d && (
        <>
          <p>
            集計 {d.summary.matches}試合（詳細記録あり {d.summary.recordedMatches}試合） /
            正答 {d.summary.correct} / 誤答 {d.summary.wrong} / 時間切れ{' '}
            {d.summary.timeouts} / 正答時平均 {time(d.summary.correctMs)}（
            {d.summary.correctSamples}回） / 誤答時平均 {time(d.summary.wrongMs)}（
            {d.summary.wrongSamples}回）
          </p>
          <DataTable
            label="調査対象の戦績"
            sorting={m.displaySorting}
            busy={m.busy}
            onSort={m.sort}
            columns={[
              { label: '区分・日時', key: 'finishedAt', initial: 'desc' },
              { label: '結果', key: 'outcome' },
              { label: '正答', key: 'correct', initial: 'desc' },
              { label: '誤答', key: 'wrong', initial: 'desc' },
              { label: '時間切れ', key: 'timeouts', initial: 'desc' },
              { label: '正答時平均', key: 'correctMs', initial: 'desc' },
              { label: '誤答時平均', key: 'wrongMs', initial: 'desc' },
              { label: 'レート増減', key: 'ratingDelta', initial: 'desc' },
              '詳細',
            ]}
          >
            {[...(d.reported ? [d.reported] : []), ...d.rows].map((r, i) => (
              <tr key={r.resultId}>
                <td>
                  {d.reported && i === 0 && <strong>通報対象 / </strong>}
                  {new Date(r.finishedAt).toLocaleString()}
                </td>
                <td>{r.outcome}</td>
                <td>{r.correct}</td>
                <td>{r.wrong ?? `未記録（お手つき合計 ${r.mistakes}）`}</td>
                <td>{r.timeouts ?? '未記録'}</td>
                <td>{time(r.correctMs)}</td>
                <td>{time(r.wrongMs)}</td>
                <td>{r.ratingDelta}</td>
                <td>
                  <details>
                    <summary>参加者</summary>
                    {r.players.map((p) => (
                      <p key={p.name}>
                        {p.name}：正答{p.correct}・お手つき{p.mistakes}
                      </p>
                    ))}
                  </details>
                </td>
              </tr>
            ))}
          </DataTable>
          <Pagination
            value={d.pagination}
            pageSize={m.pageSize}
            disabled={m.busy}
            onChange={m.change}
          />
        </>
      )}
    </section>
  );
}
