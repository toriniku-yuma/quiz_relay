import { useEffect, useState } from 'react';
import type { QuestionSharingOverview } from '../../../shared/federation-questions';
import type { useQuestionSharing } from './useQuestionSharing';

export function useQuestionImportForm(
  sharing: ReturnType<typeof useQuestionSharing>,
  initial: QuestionSharingOverview['imports'][number] | undefined,
  onSaved: () => void,
) {
  const [id] = useState(initial?.id ?? crypto.randomUUID()),
    [revision] = useState(initial?.revision ?? 0),
    [sourceKey, setSourceKey] = useState(
      initial ? `${initial.peerOrigin}|${initial.sourceInstanceId}` : '',
    ),
    [range, setRange] = useState(
      initial ? (initial.config.categories.length ? 'selected' : 'all') : '',
    ),
    [selectedCategories, setSelectedCategories] = useState(
      initial?.config.categories ?? [],
    ),
    [destination, setDestination] = useState(initial?.config.targetCategoryId ?? ''),
    [newCategoryId] = useState(crypto.randomUUID()),
    [newCategoryName, setNewCategoryName] = useState(''),
    [enabled, setEnabled] = useState(initial?.enabled ?? true),
    [catalog, setCatalog] = useState<{
      categories: { id: string; name: string }[];
      ready: boolean;
      errorCode: string | null;
    } | null>(null),
    [catalogFailed, setCatalogFailed] = useState(false);
  const source = sharing.data?.sources.find(
      (item) => `${item.peerOrigin}|${item.instanceId}` === sourceKey,
    ),
    [peerOrigin, sourceInstanceId] = sourceKey.split('|'),
    request = sharing.request;
  useEffect(() => {
    let cancelled = false;
    setCatalog(null);
    setCatalogFailed(false);
    if (!sourceKey) return;
    async function load() {
      const result = await request<NonNullable<typeof catalog>>(
        { operation: 'source', peerOrigin, sourceInstanceId },
        true,
      );
      if (!cancelled) {
        setCatalog(result);
        setCatalogFailed(!result);
      }
    }
    void load();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, 15000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [sourceKey, peerOrigin, sourceInstanceId, request]);
  const ready =
    !!sourceKey &&
    !!range &&
    !!destination &&
    (range === 'all' || selectedCategories.length > 0) &&
    (!destination.startsWith('new-') || !!newCategoryName.trim());
  async function save() {
    if (!ready) return;
    const isNew = destination.startsWith('new-');
    if (
      await sharing.mutate({
        operation: 'import',
        id,
        revision,
        peerOrigin,
        sourceInstanceId,
        enabled,
        config: {
          categories: range === 'all' ? [] : selectedCategories,
          targetCategoryId: isNew ? newCategoryId : destination,
          difficulty: { '0': 0, '1': 1, '2': 2 },
          fallback: 0,
        },
        ...(isNew
          ? { newCategoryName, newCategoryImportOnly: destination === 'new-import-only' }
          : {}),
      })
    )
      onSaved();
  }
  return {
    sourceKey,
    source,
    setSourceKey,
    range,
    setRange,
    selectedCategories,
    setSelectedCategories,
    destination,
    setDestination,
    newCategoryName,
    setNewCategoryName,
    enabled,
    setEnabled,
    catalog,
    catalogFailed,
    ready,
    save,
    sourceInstanceId,
  };
}
