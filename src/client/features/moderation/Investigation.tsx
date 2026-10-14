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
  const model = useInvestigation(instanceId, actorId, reportId),
    data = model.data;
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
          value={model.sample}
          disabled={model.all}
          onChange={(event) => model.setSample(event.target.value)}
        />
        <label className="py-3">
          <Checkbox
            checked={model.all}
            onChange={(event) => model.setAll(event.target.checked)}
          />{' '}
          全件
        </label>
      </div>
      <p className="text-sm">
        {reportId ? '通報された試合より前の、' : ''}
        同じインスタンスの戦績です。平均の対象件数と一覧の表示件数は独立しています。早押し時間は解答・判定・中断中を除外します。誤答・時間切れの集計は詳細記録のある試合のみを対象にします。未記録の試合を0秒として扱いません。
      </p>
      {model.error && (
        <>
          <p role="alert">{model.error}</p>
          <Button onClick={model.retry}>再試行</Button>
        </>
      )}
      {model.busy && (
        <p role="status" className={data ? 'sr-only' : undefined}>
          戦績を取得しています。
        </p>
      )}
      {data && (
        <>
          <p>
            集計 {data.summary.matches}試合 / 正答 {data.summary.correct} / 誤答{' '}
            {data.summary.wrong} / 時間切れ {data.summary.timeouts} / 正答時平均{' '}
            {time(data.summary.correctMs)}（{data.summary.correctSamples}回） / 誤答時平均{' '}
            {time(data.summary.wrongMs)}（{data.summary.wrongSamples}回）
          </p>
          <DataTable
            label="調査対象の戦績"
            sorting={model.displaySorting}
            busy={model.busy}
            onSort={model.sort}
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
            {[...(data.reported ? [data.reported] : []), ...data.rows].map(
              (result, i) => (
                <tr key={result.resultId}>
                  <td>
                    {data.reported && i === 0 && <strong>通報対象 / </strong>}
                    {new Date(result.finishedAt).toLocaleString()}
                  </td>
                  <td>{result.outcome}</td>
                  <td>{result.correct}</td>
                  <td>{result.wrong}</td>
                  <td>{result.timeouts}</td>
                  <td>{time(result.correctMs)}</td>
                  <td>{time(result.wrongMs)}</td>
                  <td>{result.ratingDelta}</td>
                  <td>
                    <details>
                      <summary>参加者</summary>
                      {result.players.map((player) => (
                        <p key={player.name}>
                          {player.name}：正答{player.correct}・お手つき{player.mistakes}
                        </p>
                      ))}
                    </details>
                  </td>
                </tr>
              ),
            )}
          </DataTable>
          <Pagination
            value={data.pagination}
            pageSize={model.pageSize}
            disabled={model.busy}
            onChange={model.change}
          />
        </>
      )}
    </section>
  );
}
