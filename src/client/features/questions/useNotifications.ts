import { useCallback, useEffect, useRef, useState } from 'react';
import { API_PATHS } from '../../../shared/api-paths';
import type { QuestionNotification } from '../../../shared/questions';
import { useApp } from '../../app/context';
import { organizationRequest } from '../organization/useOrganization';
import { questionsRequest } from './useQuestions';

export function useNotifications() {
  const { auth, organization, url } = useApp();
  const instances = organization.data?.instances ?? [];
  const scope = auth.user
    ? JSON.stringify(instances.map((item) => item.id).sort())
    : '[]';
  const identity = `${auth.user?.id ?? ''}:${scope}`;
  const current = useRef(identity);
  current.current = identity;
  const request = useRef(0);
  const dialog = useRef<HTMLDialogElement>(null);
  const [opened, setOpened] = useState(false);
  const [rows, setRows] = useState<(QuestionNotification & { instanceId: string })[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const refresh = useCallback(async () => {
    const version = ++request.current;
    setLoading(true);
    const ids: string[] = JSON.parse(scope);
    const results = await Promise.allSettled(
      [...ids, ...(organization.data?.account ? [''] : [])].map(async (instanceId) => {
        if (!instanceId)
          return (
            await organizationRequest<{
              notifications: (QuestionNotification & { instanceId: string })[];
            }>(API_PATHS.moderationPersonal)
          ).notifications;
        const result = await questionsRequest<{ notifications: QuestionNotification[] }>(
          instanceId,
          { operation: 'notifications' },
        );
        return result.notifications.map((row) => ({ ...row, instanceId }));
      }),
    );
    if (current.current !== identity || request.current !== version) return;
    setRows(
      results
        .flatMap((result) => (result.status === 'fulfilled' ? result.value : []))
        .sort((leftNotification, rightNotification) =>
          rightNotification.createdAt.localeCompare(leftNotification.createdAt),
        )
        .slice(0, 5),
    );
    setError(
      results.some((result) => result.status === 'rejected')
        ? '一部の通知を取得できませんでした。閉じて再度開いてください。'
        : '',
    );
    setLoading(false);
  }, [scope, identity, organization.data?.account]);

  useEffect(() => {
    setRows([]);
    dialog.current?.close();
    setOpened(false);
    void refresh();
    const update = () => {
      void refresh();
    };
    window.addEventListener('focus', update);
    window.addEventListener('notifications:refresh', update);
    return () => {
      request.current++;
      window.removeEventListener('focus', update);
      window.removeEventListener('notifications:refresh', update);
    };
  }, [refresh]);

  useEffect(() => {
    if (url.href) {
      dialog.current?.close();
      setOpened(false);
    }
  }, [url.href]);

  useEffect(() => {
    if (!opened || loading || !rows.some((row) => !row.read)) return;
    let active = true;
    const unread = rows.filter((row) => !row.read);
    void Promise.all(
      [...new Set(unread.map((row) => row.instanceId))].map(async (instanceId) => {
        const ids = unread
          .filter((row) => row.instanceId === instanceId)
          .map((row) => row.id);
        if (instanceId)
          await questionsRequest(instanceId, { operation: 'read-notifications', ids });
        else await organizationRequest(API_PATHS.moderationPersonal, { readIds: ids });
        return ids;
      }),
    )
      .then((groups) => {
        if (active && current.current === identity)
          setRows((previous) =>
            previous.map((row) =>
              groups.flat().includes(row.id) ? { ...row, read: true } : row,
            ),
          );
      })
      .catch(() => {
        if (active) setError('既読の保存に失敗しました。次に開いたときに再試行します。');
      });
    return () => {
      active = false;
    };
  }, [opened, loading, rows, identity]);

  function open() {
    dialog.current?.showModal();
    setOpened(true);
    void refresh();
    if (
      matchMedia('(max-width: 63.99rem)').matches &&
      !matchMedia('(prefers-reduced-motion: reduce)').matches
    )
      dialog.current?.animate(
        [{ transform: 'translateX(-100%)' }, { transform: 'translateX(0)' }],
        { duration: 180, easing: 'ease-out' },
      );
  }
  return {
    dialog,
    opened,
    rows,
    instances,
    error,
    loading,
    open,
    close: () => {
      dialog.current?.close();
      setOpened(false);
    },
    unread: rows.filter((row) => !row.read).length,
  };
}
