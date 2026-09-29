import { useEffect, useState } from 'react';
import { API_PATHS } from '../../../shared/api-paths';
import type { Investigation } from '../../../shared/investigation';
import type { SortState } from '../../../shared/sorting';
import { organizationRequest } from '../organization/useOrganization';
export function useInvestigation(
  instanceId: string | null,
  actorId: string,
  reportId?: string,
) {
  const [sorting, setSorting] = useState<SortState>({
    sort: 'finishedAt',
    direction: 'desc',
  });
  const [page, setPage] = useState(1),
    [pageSize, setPageSize] = useState(10),
    [sample, setSample] = useState('30'),
    [all, setAll] = useState(false),
    [revision, retry] = useState(0);
  const collection = JSON.stringify([
    instanceId,
    actorId,
    reportId,
    sample,
    all,
    pageSize,
  ]);
  const [loaded, setData] = useState<{
      collection: string;
      value: Investigation;
      sorting: SortState;
    } | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision explicitly triggers a retry.
  useEffect(() => {
    let current = true;
    setBusy(true);
    setError('');
    if (!all && (!Number.isSafeInteger(Number(sample)) || Number(sample) < 1)) {
      setError('集計する試合数を1以上の整数で入力してください。');
      setBusy(false);
      return;
    }
    void organizationRequest<Investigation>(API_PATHS.moderationHistory, {
      instanceId,
      actorId,
      reportId,
      page,
      pageSize,
      ...sorting,
      sample: all ? 'all' : Number(sample),
    })
      .then((r) => {
        if (current) setData({ collection, value: r, sorting });
      })
      .catch((e) => {
        if (current) setError(e instanceof Error ? e.message : '取得できませんでした。');
      })
      .finally(() => {
        if (current) setBusy(false);
      });
    return () => {
      current = false;
    };
  }, [
    instanceId,
    actorId,
    reportId,
    page,
    pageSize,
    sample,
    all,
    revision,
    sorting,
    collection,
  ]);
  return {
    data: loaded?.collection === collection ? loaded.value : null,
    displaySorting: loaded?.collection === collection ? loaded.sorting : sorting,
    error,
    busy,
    pageSize,
    sorting,
    sort: (value: SortState) => {
      setPage(1);
      setSorting(value);
    },
    sample,
    setSample,
    all,
    setAll,
    retry: () => retry((v) => v + 1),
    change: (value: { page?: number; pageSize?: number }) => {
      setPage(value.page ?? 1);
      if (value.pageSize) setPageSize(value.pageSize);
    },
  };
}
