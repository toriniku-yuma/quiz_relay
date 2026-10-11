import { useCallback, useEffect, useRef, useState } from 'react';
import { API_PATHS } from '../../../shared/api-paths';
import type {
  ModeratedUser,
  ModerationOverview,
  Restriction,
  Sanction,
  SanctionKind,
} from '../../../shared/moderation';
import { sanctionRevision } from '../../../shared/moderation';
import type { SortDirection, SortState } from '../../../shared/sorting';
import { useApp } from '../../app/context';
import {
  OrganizationRequestError,
  organizationRequest,
} from '../organization/useOrganization';

export function useModeration() {
  const { url, auth, organization } = useApp();
  const instanceId = url.searchParams.get('instance');
  const actorId = url.searchParams.get('actor') ?? '';
  const query = url.searchParams.get('q') ?? '';
  const cursor = url.searchParams.get('cursor') ?? '';
  const page = Number(url.searchParams.get('page') ?? 1),
    pageSize = Number(url.searchParams.get('pageSize') ?? 10),
    sort = url.searchParams.get('sort') ?? 'reports',
    filter = url.searchParams.get('filter') ?? '',
    direction = (url.searchParams.get('direction') ??
      (sort === 'name' || sort === 'origin' ? 'asc' : 'desc')) as SortDirection,
    eventPage = Number(url.searchParams.get('eventPage') ?? 1),
    eventPageSize = Number(url.searchParams.get('eventPageSize') ?? 10),
    eventSort = url.searchParams.get('eventSort') ?? 'createdAt',
    eventDirection = (url.searchParams.get('eventDirection') ?? 'desc') as SortDirection;
  const identity = JSON.stringify([
    auth.user?.id,
    instanceId,
    actorId,
    query,
    page,
    pageSize,
    sort,
    filter,
    direction,
    eventPage,
    eventPageSize,
    eventSort,
    eventDirection,
  ]);
  const collection = JSON.stringify([
    auth.user?.id,
    instanceId,
    actorId,
    query,
    pageSize,
    filter,
    eventPageSize,
  ]);
  const [loaded, setData] = useState<{
    identity: string;
    collection: string;
    sorting: SortState;
    eventSorting: SortState;
    value: ModerationOverview;
  } | null>(null);
  const data = loaded?.collection === collection ? loaded.value : null;
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const version = useRef(0);
  const history = useRef<{ target: string; before?: string }>({ target: '' });
  const target = JSON.stringify([auth.user?.id, instanceId, actorId]);
  const enabled =
    !!auth.user &&
    !!organization.data?.account &&
    (!!instanceId || organization.data.account.administrator);
  const refresh = useCallback(async () => {
    if (!enabled) return;
    const request = ++version.current;
    setBusy(true);
    setError('');

    try {
      const next = await organizationRequest<ModerationOverview>(
        API_PATHS.moderationUsers,
        {
          instanceId,
          actorId,
          query,
          page,
          pageSize,
          sort,
          filter,
          direction,
          eventPage,
          eventPageSize,
          eventSort,
          eventDirection,
          eventsBefore:
            history.current.target === target ? history.current.before : undefined,
        },
      );
      if (request === version.current) {
        history.current = { target, before: next.eventsBefore };
        setData({
          identity,
          collection,
          sorting: { sort, direction },
          eventSorting: { sort: eventSort, direction: eventDirection },
          value: next,
        });
      }
    } catch (error) {
      if (request === version.current)
        setError(error instanceof Error ? error.message : '取得できませんでした。');
    } finally {
      if (request === version.current) setBusy(false);
    }
  }, [
    enabled,
    instanceId,
    actorId,
    query,
    page,
    pageSize,
    sort,
    filter,
    direction,
    eventPage,
    eventPageSize,
    eventSort,
    eventDirection,
    identity,
    collection,
    target,
  ]);
  useEffect(() => {
    void refresh();
    return () => {
      version.current++;
    };
  }, [refresh]);
  return {
    data,
    displaySorting: data ? loaded?.sorting : { sort, direction },
    displayEventSorting: data
      ? loaded?.eventSorting
      : { sort: eventSort, direction: eventDirection },
    error,
    busy,
    refresh,
    instanceId,
    actorId,
    query,
    cursor,
    page,
    pageSize,
    sort,
    filter,
    direction,
    eventPage,
    eventPageSize,
    eventSort,
    eventDirection,
    enabled,
    instances: organization.data?.instances ?? [],
  };
}

export function useSanctionEditor(
  instanceId: string | null,
  actorId: string,
  saved: () => Promise<void>,
  batch?: ModeratedUser[],
) {
  const [kind, setKind] = useState<SanctionKind | ''>('');
  const [restrictions, setRestrictions] = useState<Restriction[]>([]);
  const [reason, setReason] = useState('');
  const [timing, setTiming] = useState('');
  const [duration, setDuration] = useState('');
  const [unit, setUnit] = useState('');
  const [end, setEnd] = useState('');
  const [before, setBefore] = useState<Sanction | null>(null);
  const [revoke, setRevoke] = useState(false);
  const [organizationWide, setOrganizationWide] = useState(instanceId === null);
  const [pending, setPending] = useState<Record<string, unknown> | null>(null);
  const [submitted, setSubmitted] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const sending = useRef(false);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (pending) dialog.current?.showModal();
    else dialog.current?.close();
  }, [pending]);
  function edit(row: Sanction | null, remove = false) {
    if (submitted || busy) return;
    setMessage('');
    setBefore(row);
    setOrganizationWide(row ? row.instanceId === null : instanceId === null);
    setRevoke(remove);
    setKind(row?.kind ?? '');
    setRestrictions(row?.restrictions ?? []);
    setReason('');
    setTiming(row?.expiresAt ? 'date' : '');
    setEnd(
      row?.expiresAt
        ? new Date(Date.parse(row.expiresAt) - new Date().getTimezoneOffset() * 60000)
            .toISOString()
            .slice(0, 16)
        : '',
    );
    setDuration('');
    setUnit('');
    setError('');
    setPending(null);
  }
  function preview(direct = false) {
    if (busy) return;
    if (submitted) {
      if (direct) void commit(submitted);
      else setPending(submitted);
      return;
    }
    setError('');
    if (!reason.trim() || reason.length > 1000) {
      setError('理由を1〜1000文字で入力してください。');
      return;
    }
    if (!kind || (kind === 'partial' && !revoke && !restrictions.length)) {
      setError('処分の種類・制限対象を選択してください。');
      return;
    }
    let expiresAt: string | null = null;
    const preparedAt = Date.now();
    if (!revoke && kind === 'timeout') {
      const stamp =
        timing === 'duration' && duration && unit
          ? preparedAt + Number(duration) * Number(unit) * 60000
          : timing === 'date'
            ? new Date(end).getTime()
            : NaN;
      if (
        !Number.isFinite(stamp) ||
        stamp < preparedAt + 60000 ||
        stamp > preparedAt + 30 * 86400000
      ) {
        setError('終了日時は現在から1分以上30日以内にしてください。');
        return;
      }
      expiresAt = new Date(stamp).toISOString();
    }
    const request = {
      instanceId,
      organizationWide: kind === 'ban' && organizationWide,
      actorId,
      operationId: crypto.randomUUID(),
      action: revoke ? 'revoke' : before ? 'change' : 'add',
      id: before?.id,
      revision: before?.revision,
      kind,
      restrictions: kind === 'partial' ? restrictions : [],
      expiresAt,
      preparedAt,
      reason: reason.trim(),
    };
    const payload = batch
      ? {
          ...request,
          action: 'bulk',
          batchAction: revoke ? 'revoke' : 'add',
          targets: batch.map((user) => ({
            actorId: user.actorId,
            expected: sanctionRevision(
              (user.sanctions ?? []).filter(
                (sanction) =>
                  sanction.instanceId === null || sanction.instanceId === instanceId,
              ),
            ),
          })),
        }
      : request;
    if (direct) void commit(payload);
    else setPending(payload);
  }
  async function commit(request = pending) {
    if (!request || sending.current) return;
    sending.current = true;
    setBusy(true);
    setSubmitted(request);
    setError('');
    try {
      await organizationRequest(API_PATHS.moderationMutate, request);
      setSubmitted(null);
      setPending(null);
      setKind('');
      setBefore(null);
      setRevoke(false);
      setReason('');
      setRestrictions([]);
      setOrganizationWide(false);
      setMessage('保存しました。');
      window.dispatchEvent(new Event('notifications:refresh'));
      try {
        await saved();
      } catch {
        setError('保存しましたが一覧の更新に失敗しました。再読み込みしてください。');
      }
    } catch (error) {
      // A definite rejection permits editing; transport failures and 5xx may follow a commit.
      if (
        error instanceof OrganizationRequestError &&
        error.status >= 400 &&
        error.status < 500 &&
        error.status !== 408
      )
        setSubmitted(null);
      setError(
        error instanceof Error
          ? error.message
          : '保存できませんでした。同じ内容で再試行してください。',
      );
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }
  return {
    message,
    organizationWide,
    setOrganizationWide,
    kind,
    setKind,
    restrictions,
    setRestrictions,
    reason,
    setReason,
    timing,
    setTiming,
    duration,
    setDuration,
    unit,
    setUnit,
    end,
    setEnd,
    before,
    revoke,
    pending,
    uncertain: !!submitted,
    clearError: () => setError(''),
    error,
    busy,
    dialog,
    edit,
    preview,
    commit,
    back: () => {
      if (!busy) setPending(null);
    },
  };
}
