import { useState } from 'react';
import {
  restrictionLabels,
  type Sanction,
  sanctionLabels,
} from '../../../shared/moderation';
import { useApp } from '../../app/context';
import { navigate } from '../../app/navigation';
import { USERS_PATH } from '../../app/paths';
import Button from '../../components/Button';
import Checkbox from '../../components/Checkbox';
import DataTable from '../../components/DataTable';
import Pagination from '../../components/Pagination';
import TextField from '../../components/TextField';
import { useTableSelection } from '../../components/useTableSelection';
import Investigation from './Investigation';
import SanctionEditor from './SanctionEditor';
import UserActions from './UserActions';
import UserCases from './UserCases';
import { useActiveSanctions } from './useActiveSanctions';
import { useModeration } from './useModeration';
export default function UsersPanel() {
  const model = useModeration(),
    { url, auth } = useApp(),
    { data } = model;
  const selection = useTableSelection<
    { id: string } & import('../../../shared/moderation').ModeratedUser
  >(JSON.stringify([auth.user?.id, model.instanceId, model.query, model.filter]));
  const [bulkOpen, setBulkOpen] = useState(false);
  const visible = (data?.users ?? []).map((u) => ({ ...u, id: u.actorId }));
  const allSelected =
    visible.length > 0 && visible.every((u) => selection.rows.some((s) => s.id === u.id));
  const active = useActiveSanctions(data?.users.flatMap((u) => u.sanctions ?? []) ?? []);
  const describe = (s: Sanction) =>
    `${sanctionLabels[s.kind]} / ${s.restrictions.map((k) => restrictionLabels[k]).join('・') || '新規対戦・部屋作成・問題提出'} / ${s.expiresAt ? new Date(s.expiresAt).toLocaleString() : '期限なし'} / ${s.reason}${s.revokedAt ? ' / 取消済み' : ''}`;
  const href = (changes: Record<string, string | number>) => {
    const q = new URLSearchParams(url.search);
    for (const [k, v] of Object.entries(changes)) {
      if (v === '') q.delete(k);
      else q.set(k, String(v));
    }
    return `${USERS_PATH}?${q}`;
  };
  const change = (values: Record<string, string | number>) =>
    navigate(href({ page: 1, ...values }));
  if (!model.instanceId)
    return <p>メニューから対象インスタンスのユーザー管理を選んでください。</p>;
  return (
    <div className="grid gap-5">
      {!model.enabled && <p>ログインして権限を確認してください。</p>}
      {model.error && (
        <>
          <p role="alert">{model.error}</p>
          <Button disabled={model.busy} onClick={model.refresh}>
            再試行
          </Button>
        </>
      )}
      {model.busy && (
        <p role="status" className={data ? 'sr-only' : undefined}>
          読み込んでいます。
        </p>
      )}
      {data && (
        <>
          <p className="font-bold">{data.scopeName}</p>
          {data.target ? (
            <>
              <a className="underline" href={href({ actor: '' })}>
                ユーザー一覧に戻る
              </a>
              <h2 className="text-xl font-bold">{data.target.name}</h2>
              <p>所属元：{data.target.origin}</p>
              <Investigation
                instanceId={model.instanceId}
                actorId={data.target.actorId}
              />
              <h3 className="font-bold">処分・調査履歴</h3>
              <DataTable
                label="処分・調査履歴"
                sorting={model.displayEventSorting}
                busy={model.busy}
                onSort={(value) =>
                  navigate(
                    href({
                      eventPage: 1,
                      eventSort: value.sort,
                      eventDirection: value.direction,
                    }),
                  )
                }
                columns={[
                  { label: '日時', key: 'createdAt', initial: 'desc' },
                  { label: '操作', key: 'action' },
                  { label: '操作者', key: 'operator' },
                  { label: '範囲', key: 'scope' },
                  { label: '理由', key: 'reason' },
                  '変更内容',
                ]}
              >
                {data.events.map((row) => (
                  <tr key={row.id}>
                    <td>{new Date(row.createdAt).toLocaleString()}</td>
                    <td>
                      {
                        {
                          add: '追加',
                          change: '変更',
                          revoke: '取消',
                          inspect: '調査閲覧',
                        }[row.action]
                      }
                    </td>
                    <td>{data.operatorNames?.[row.operatorId] ?? '表示名未登録'}</td>
                    <td>{row.instanceId === null ? '組織全体' : data.scopeName}</td>
                    <td className="whitespace-pre-wrap">{row.reason}</td>
                    <td>
                      {row.before && <p>変更前：{describe(row.before)}</p>}
                      {row.after ? <p>変更後：{describe(row.after)}</p> : '—'}
                    </td>
                  </tr>
                ))}
              </DataTable>
              <Pagination
                value={data.eventsPagination}
                pageSize={model.eventPageSize}
                disabled={model.busy}
                onChange={(value) =>
                  navigate(
                    href({
                      eventPage: value.page ?? 1,
                      eventPageSize: value.pageSize ?? model.eventPageSize,
                    }),
                  )
                }
              />
            </>
          ) : (
            <>
              <form
                className="flex flex-wrap items-end gap-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  change({ q: String(new FormData(e.currentTarget).get('q') ?? '') });
                }}
              >
                <TextField
                  id="user-search"
                  name="q"
                  label="名前・所属元で検索"
                  placeholder="例：ゆま"
                  defaultValue={model.query}
                />
                <Button type="submit">検索</Button>
                <label className="grid gap-2">
                  絞り込み
                  <select
                    className="h-12 border border-line bg-paper p-3"
                    value={model.filter}
                    onChange={(e) => change({ filter: e.target.value })}
                  >
                    <option value="">すべて</option>
                    <option value="restricted">処分中</option>
                    <option value="reports">未対応の通報あり</option>
                    <option value="appeals">未対応の異議申し立てあり</option>
                  </select>
                </label>
              </form>
              <div className="flex items-center gap-3">
                <span>選択中 {selection.rows.length}件</span>
                <Button
                  disabled={!selection.rows.length}
                  onClick={() => setBulkOpen(true)}
                >
                  一括操作
                </Button>
                <Button disabled={!selection.rows.length} onClick={selection.clear}>
                  選択解除
                </Button>
              </div>
              <SanctionEditor
                batch={selection.rows}
                data={{ ...data, target: undefined, canModerate: true, sanctions: [] }}
                instanceId={model.instanceId}
                saved={async () => {
                  await model.refresh();
                  selection.clear();
                  setBulkOpen(false);
                }}
                open={bulkOpen}
                onClose={() => setBulkOpen(false)}
              />
              <DataTable
                selection={
                  <Checkbox
                    aria-label="このページのユーザーをすべて選択"
                    checked={allSelected}
                    mixed={
                      !allSelected &&
                      visible.some((u) => selection.rows.some((s) => s.id === u.id))
                    }
                    onChange={(e) => selection.select(visible, e.target.checked)}
                  />
                }
                label="ユーザー一覧"
                sorting={model.displaySorting}
                busy={model.busy}
                onSort={change}
                columns={[
                  { label: '表示名', key: 'name', initial: 'asc' },
                  { label: '所属元', key: 'origin', initial: 'asc' },
                  { label: '権限', key: 'role', initial: 'desc' },
                  { label: '有効な処分', key: 'sanction', initial: 'desc' },
                  { label: '期限', key: 'expiresAt', initial: 'desc' },
                  { label: '未対応の通報', key: 'reports', initial: 'desc' },
                  { label: '異議申し立て', key: 'appeals', initial: 'desc' },
                  '操作',
                ]}
              >
                {data.users.map((row) => (
                  <tr key={row.actorId}>
                    <td>
                      <Checkbox
                        aria-label={`${row.name}を選択`}
                        checked={selection.rows.some((s) => s.id === row.actorId)}
                        onChange={(e) =>
                          selection.select(
                            [{ ...row, id: row.actorId }],
                            e.target.checked,
                          )
                        }
                      />
                    </td>
                    <td>
                      <a
                        className="font-bold underline"
                        href={href({ actor: row.actorId })}
                      >
                        {row.name}
                      </a>
                    </td>
                    <td>{row.origin}</td>
                    <td>
                      {row.administrator
                        ? '管理者'
                        : row.permissions
                            ?.map(
                              (p) =>
                                ({
                                  users: 'ユーザー管理',
                                  questions: '問題管理',
                                  authors: '作問者管理',
                                })[p],
                            )
                            .join('・') || '一般'}
                    </td>
                    <td>
                      {active
                        .filter((s) => s.actorId === row.actorId)
                        .map(
                          (s) =>
                            `${s.instanceId === null ? '組織全体：' : ''}${sanctionLabels[s.kind]}`,
                        )
                        .join(' / ') || 'なし'}
                    </td>
                    <td>
                      {active
                        .filter((s) => s.actorId === row.actorId)
                        .map((s) =>
                          s.expiresAt
                            ? new Date(s.expiresAt).toLocaleString()
                            : '期限なし',
                        )
                        .join(' / ') || '—'}
                    </td>
                    <td>
                      <UserCases
                        user={row}
                        instanceId={model.instanceId}
                        kind="reports"
                        saved={model.refresh}
                      />
                    </td>
                    <td>
                      <UserCases
                        user={row}
                        instanceId={model.instanceId}
                        kind="appeals"
                        saved={model.refresh}
                      />
                    </td>
                    <td>
                      <UserActions
                        user={row}
                        instanceId={model.instanceId}
                        administrator={!!data.administrator}
                        saved={model.refresh}
                      />
                    </td>
                  </tr>
                ))}
              </DataTable>
              {!data.users.length && <p>該当するユーザーはいません。</p>}
              <Pagination
                value={data.pagination}
                pageSize={model.pageSize}
                disabled={model.busy}
                onChange={(v) => change(v)}
              />
            </>
          )}
        </>
      )}
    </div>
  );
}
