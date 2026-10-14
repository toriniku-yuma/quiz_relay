import { useCallback, useEffect, useRef, useState } from 'react';
import { API_PATHS } from '../../../shared/api-paths';
import type { ParticipationTarget } from '../../../shared/participation';
import {
  OrganizationRequestError,
  organizationRequest,
} from '../organization/useOrganization';
import { foreignReturnUrl } from './redirect';

export function useParticipationAuthorization(
  target: ParticipationTarget | null,
  state: string,
  operationId: string,
  request: { flow: 'login' | 'participation'; ready: boolean; actor: string },
) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [expired, setExpired] = useState(false);
  const requestKey = JSON.stringify([
      target,
      state,
      operationId,
      request.flow,
      request.actor,
    ]),
    active = useRef(requestKey),
    inFlight = useRef<string | null>(null);
  active.current = requestKey;
  const authorize = useCallback(async () => {
    if (expired || inFlight.current === requestKey) return;
    if (!target) {
      setError('開催先の参加画面から本人確認を開き直してください。');
      return;
    }
    inFlight.current = requestKey;
    setBusy(true);
    setError('');
    try {
      const result = await organizationRequest<{ ticket: string }>(
        request.flow === 'login'
          ? API_PATHS.foreignLoginTickets
          : API_PATHS.participationTickets,
        request.flow === 'login' ? { ...target, state } : { ...target, operationId },
      );
      if (active.current !== requestKey) return;
      location.replace(foreignReturnUrl(target, state, result.ticket));
    } catch (error) {
      if (active.current !== requestKey) return;
      inFlight.current = null;
      setExpired(
        error instanceof OrganizationRequestError &&
          ['STALE_REQUEST', 'STALE_RESERVATION'].includes(error.code),
      );
      setError(error instanceof Error ? error.message : '参加を確認できませんでした。');
    } finally {
      if (active.current === requestKey) setBusy(false);
    }
  }, [requestKey, target, request.flow, state, operationId, expired]);
  useEffect(() => {
    if (request.ready && !error) void authorize();
  }, [request.ready, error, authorize]);
  return { busy, error, expired, authorize };
}
