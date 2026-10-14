import { useEffect, useMemo, useRef, useState } from 'react';
import { API_PATHS } from '../../../shared/api-paths';
import {
  type ForeignLoginOverview,
  participationTarget,
} from '../../../shared/participation';
import { navigate } from '../../app/navigation';
import { PlayRequestError } from '../rooms/api';
import {
  beginForeignAuthorization,
  clearForeignAuthorization,
  foreignAuthorizationCallback,
  foreignPlayPath,
  readForeignAuthorization,
} from './redirect';
import { clearForeignRoomEntry } from './roomEntry';
import { foreignRequest, type useForeignParticipation } from './useForeignParticipation';

export function useForeignLogin(
  ready: boolean,
  localSignedIn: boolean,
  url: URL,
  participation: ReturnType<typeof useForeignParticipation>,
) {
  const [data, setData] = useState<ForeignLoginOverview | null>(null),
    [checked, setChecked] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    revision = useRef(0),
    initialized = useRef(false),
    failedEntry = useRef('');
  const { exchange, endSession } = participation;
  // Removing the fragment changes useLocation's snapshot on the next render.
  // Keep the in-memory return request until its exchange finishes.
  const returnedUrl = useRef(url.hash.includes('qr_ticket') ? url : null),
    requestUrl = returnedUrl.current ?? url;
  const entry = useMemo(() => participationTarget(requestUrl), [requestUrl]),
    hasCallback = requestUrl.hash.includes('qr_ticket');
  const requestKey = JSON.stringify([
    entry,
    hasCallback ? requestUrl.hash : '',
    localSignedIn,
  ]);
  useEffect(() => {
    if (!ready || (initialized.current && !entry && !hasCallback && !localSignedIn))
      return;
    initialized.current = true;
    const generation = ++revision.current;
    if (localSignedIn) {
      setData(null);
      setChecked(true);
      setBusy(false);
      setError('');
      clearForeignAuthorization();
      returnedUrl.current = null;
      if (entry || hasCallback)
        navigate(
          `${requestUrl.pathname}?instance=${requestUrl.searchParams.get('instance') ?? ''}`,
          true,
        );
      return;
    }
    let active = true;
    setBusy(true);
    setError('');
    const pending = readForeignAuthorization(sessionStorage),
      callback = foreignAuthorizationCallback(requestUrl, pending);
    // Remove one-use credentials before any further navigation or external request.
    if (hasCallback)
      history.replaceState(null, '', `${requestUrl.pathname}${requestUrl.search}`);
    void (async () => {
      if (hasCallback) {
        if (!callback)
          throw new Error(
            'ログインの戻り先を確認できません。所属元から開き直してください。',
          );
        if (callback.pending.flow === 'login')
          await foreignRequest(API_PATHS.foreignLoginExchange, {
            ...callback.pending.target,
            state: callback.pending.state,
            ticket: callback.ticket,
          });
        else await exchange(callback.ticket, callback.pending.target);
        clearForeignAuthorization();
      }
      let snapshot: ForeignLoginOverview | null = null;
      try {
        snapshot = await foreignRequest<ForeignLoginOverview>(
          API_PATHS.foreignLoginSession,
        );
      } catch (error) {
        if (
          !(error instanceof PlayRequestError) ||
          (error.status !== 401 &&
            !(!entry && !hasCallback && error.code === 'FEDERATION_NOT_CONFIGURED'))
        )
          throw error;
      }
      if (!active || revision.current !== generation) return;
      setData(snapshot);
      setChecked(true);
      setBusy(false);
      returnedUrl.current = null;
      if (entry && failedEntry.current !== requestKey) {
        if (
          !snapshot ||
          snapshot.account.homeOrigin !== entry.peerOrigin ||
          snapshot.account.organizationId !== entry.sourceOrganizationId
        )
          beginForeignAuthorization(entry, 'login');
        else
          navigate(
            `${foreignPlayPath(entry.mode)}?instance=${entry.hostInstanceId}`,
            true,
          );
      } else if (hasCallback)
        navigate(`${requestUrl.pathname}${requestUrl.search}`, true);
    })()
      .catch((error) => {
        if (active && revision.current === generation) {
          failedEntry.current = requestKey;
          setChecked(true);
          setError(
            error instanceof Error ? error.message : '外部ログインを確認できません。',
          );
        }
      })
      .finally(() => {
        if (active && revision.current === generation) setBusy(false);
      });
    return () => {
      active = false;
      revision.current++;
    };
  }, [ready, localSignedIn, requestKey, entry, hasCallback, requestUrl, exchange]);

  async function logout() {
    setBusy(true);
    setError('');
    revision.current++;
    try {
      try {
        await foreignRequest(
          API_PATHS.foreignLoginLogout,
          {},
          participation.session?.reservationId,
        );
      } catch (error) {
        if (
          !(error instanceof PlayRequestError) ||
          error.code !== 'FEDERATION_NOT_CONFIGURED'
        )
          throw error;
      }
      clearForeignAuthorization();
      returnedUrl.current = null;
      clearForeignRoomEntry();
      endSession();
      setData(null);
      setChecked(true);
      navigate(
        `${url.pathname === '/rooms/' ? '/rooms/' : url.pathname === '/casual/' ? '/casual/' : '/game/'}?instance=${url.searchParams.get('instance') ?? ''}&guest=1`,
        true,
      );
      return true;
    } catch (error) {
      setError(error instanceof Error ? error.message : 'ログアウトを完了できません。');
      return false;
    } finally {
      setBusy(false);
    }
  }
  return { data, checked, busy, error, logout };
}
