import { useCallback, useEffect, useRef, useState } from 'react';
import { API_PATHS } from '../../../shared/api-paths';
import { useGame } from '../game/useGame';
import { PlayRequestError, playRequest } from '../rooms/api';
import { MatchError, matchRequest, resumeMatch } from './api';

export function useMatchmaking(
  subject: string,
  instanceId = '',
  mode: 'ranked' | 'casual' = 'ranked',
  targetInstanceId = instanceId,
) {
  const request =
    mode === 'casual'
      ? playRequest<{
          room?: string;
          operationId?: string;
          playersPerMatch?: number;
          rules?: { correctAnswersToWin: number; mistakesToDisqualify: number };
        }>
      : matchRequest;
  const game = useGame(
    'formal',
    instanceId
      ? `${mode === 'casual' ? 'casual:' : ''}${subject}:${instanceId}`
      : subject,
    instanceId,
  );
  const { attach, leave } = game;
  const currentGame = useRef(game);
  currentGame.current = game;
  const [busy, setBusy] = useState(false);
  const [restoring, setRestoring] = useState(true);
  const [config, setConfig] = useState<{
    instanceId: string;
    data?: Awaited<ReturnType<typeof matchRequest>>;
    error: string;
  } | null>(null);
  const [error, setError] = useState('');
  const [activeInstance, setActiveInstance] = useState('');
  const operation = useRef(0);
  const joining = useRef<{
    operationId: string;
    name: string;
    instanceId: string;
  } | null>(null);
  const cancellation = useRef<{
    body: { room: string } | { operationId: string };
    instanceId: string;
    previous?: { room: string; instanceId: string };
  } | null>(null);
  const [cancelAttempt, setCancelAttempt] = useState(0);
  const [uncertain, setUncertain] = useState(false);
  const [restored, setRestored] = useState(false);
  const [viewing, setViewing] = useState(true);
  const offerRestore = useCallback(() => {
    setRestored(true);
    setViewing(false);
  }, []);
  const restore = useCallback(
    async (target: string) => {
      const resume = (id: string) =>
        mode === 'casual' ? request(API_PATHS.casualResume, {}, id) : resumeMatch(id);
      try {
        return { ...(await resume(target)), instanceId: target };
      } catch (error) {
        if (
          (error instanceof MatchError || error instanceof PlayRequestError) &&
          error.code === 'OTHER_INSTANCE_ACTIVE' &&
          error.mode === mode &&
          error.instanceId
        )
          return { ...(await resume(error.instanceId)), instanceId: error.instanceId };
        throw error;
      }
    },
    [mode, request],
  );
  useEffect(() => {
    if (instanceId && !targetInstanceId) return;
    let active = true;
    void request(
      mode === 'casual' ? API_PATHS.casualConfig : API_PATHS.matchConfig,
      {},
      targetInstanceId,
    )
      .then((data) => {
        if (active) setConfig({ instanceId: targetInstanceId, data, error: '' });
      })
      .catch((error: unknown) => {
        if (active)
          setConfig({
            instanceId: targetInstanceId,
            error:
              error instanceof Error ? error.message : '出題設定を読み込めませんでした。',
          });
      });
    return () => {
      active = false;
    };
  }, [targetInstanceId, instanceId, mode, request]);
  useEffect(() => {
    let active = true;
    const restoringOperation = ++operation.current;
    void (
      mode === 'casual' && !subject
        ? Promise.resolve({ room: undefined })
        : restore(instanceId)
    )
      .then((result) => {
        if (active && operation.current === restoringOperation && result.room) {
          attach(result.room, 'instanceId' in result ? result.instanceId : instanceId);
          offerRestore();
        }
      })
      .catch((error) => {
        if (!active || operation.current !== restoringOperation) return;
        if (
          (error instanceof MatchError || error instanceof PlayRequestError) &&
          ['NO_ACTIVE_MATCH', 'OTHER_INSTANCE_ACTIVE'].includes(error.code)
        )
          leave();
        else {
          setError(error.message);
          if (error instanceof MatchError) setActiveInstance(error.instanceId ?? '');
        }
      })
      .finally(() => {
        if (active) setRestoring(false);
      });
    return () => {
      active = false;
    };
  }, [attach, leave, instanceId, mode, subject, offerRestore, restore]);
  useEffect(() => {
    if (
      !['closed', 'stopped'].includes(game.connection) ||
      game.snapshot?.phase !== 'WAITING'
    )
      return;
    const checking = operation.current;
    // A broken tab never cancels another live tab. The server decides whether the last connection has gone.
    void restore(game.roomInstanceId).catch((error) => {
      if (
        operation.current === checking &&
        (error instanceof MatchError || error instanceof PlayRequestError) &&
        error.code === 'NO_ACTIVE_MATCH'
      )
        leave();
    });
  }, [game.connection, game.snapshot?.phase, game.roomInstanceId, restore, leave]);
  useEffect(() => {
    const target = cancellation.current;
    if (!cancelAttempt) return;
    if (!target) return;
    let active = true;
    let retry: ReturnType<typeof setTimeout>;
    let recoveryInstance = target.instanceId;
    const finish = (message = '') => {
      joining.current = null;
      cancellation.current = null;
      setUncertain(false);
      setRestored(false);
      setViewing(true);
      const cancelledRoom =
        target.previous?.room ?? ('room' in target.body ? target.body.room : null);
      if (cancelledRoom && currentGame.current.roomId === cancelledRoom) leave();
      setBusy(false);
      setError(message);
    };
    setBusy(true);
    void request(
      mode === 'casual' ? API_PATHS.casualCancel : API_PATHS.matchCancel,
      target.body,
      target.instanceId,
    )
      .then(async () => {
        if (!active || cancellation.current !== target) return;
        if (target.previous) {
          recoveryInstance = target.previous.instanceId;
          await request(
            mode === 'casual' ? API_PATHS.casualCancel : API_PATHS.matchCancel,
            { room: target.previous.room },
            target.previous.instanceId,
          );
          if (!active || cancellation.current !== target) return;
        }
        finish();
      })
      .catch(async (error) => {
        if (!active || cancellation.current !== target) return;
        if (
          (error instanceof MatchError || error instanceof PlayRequestError) &&
          error.code === 'MATCH_STARTED'
        ) {
          // The server may have started before the explicit cancellation arrived.
          try {
            const result = await restore(recoveryInstance);
            if (!active || cancellation.current !== target) return;
            if (result.room) attach(result.room, result.instanceId);
            joining.current = null;
            cancellation.current = null;
            setUncertain(false);
            setViewing(true);
            setBusy(false);
            return;
          } catch (recoveryError) {
            if (!active || cancellation.current !== target) return;
            error = recoveryError;
          }
        }
        if (
          (error instanceof MatchError || error instanceof PlayRequestError) &&
          error.status < 500 &&
          error.status !== 429
        ) {
          finish(
            ['STALE_ROOM', 'STALE_REQUEST', 'NO_ACTIVE_MATCH'].includes(error.code)
              ? ''
              : error.message,
          );
          return;
        }
        setError('待機の解除を確認しています。通信が戻り次第、再試行します。');
        retry = setTimeout(() => setCancelAttempt((attempt) => attempt + 1), 1500);
      });
    return () => {
      active = false;
      clearTimeout(retry);
    };
  }, [cancelAttempt, request, mode, attach, leave, restore]);
  useEffect(() => {
    if (game.snapshot?.phase === 'WAITING') {
      setRestored(false);
      setViewing(true);
    }
  }, [game.snapshot?.phase]);
  async function run(task: (isCurrent: () => boolean) => Promise<void>) {
    const running = ++operation.current;
    const isCurrent = () => operation.current === running;
    setBusy(true);
    setError('');
    try {
      await task(isCurrent);
    } catch (error) {
      if (!isCurrent()) return;
      setError(error instanceof Error ? error.message : '通信に失敗しました。');
      if (error instanceof MatchError) setActiveInstance(error.instanceId ?? '');
    } finally {
      if (isCurrent()) setBusy(false);
    }
  }
  const currentConfig = config?.instanceId === targetInstanceId ? config : null;
  return {
    game,
    busy: busy || restoring || !!cancellation.current,
    players: currentConfig?.data?.playersPerMatch ?? null,
    rules: currentConfig?.data?.rules ?? null,
    error: error || currentConfig?.error || '',
    activeInstance,
    uncertain,
    restored,
    viewing,
    offerRestore,
    dismissRestored: () => setRestored(false),
    join: (name: string) =>
      run(async () => {
        if (cancellation.current) return;
        joining.current ??= {
          name,
          operationId: crypto.randomUUID(),
          instanceId: targetInstanceId,
        };
        const pending = joining.current;
        try {
          const { instanceId: target, ...body } = pending;
          const result = await request(
            mode === 'casual' ? API_PATHS.casualJoin : API_PATHS.matchJoin,
            body,
            target,
          );
          if (joining.current !== pending || cancellation.current) return;
          joining.current = null;
          setUncertain(false);
          setRestored(false);
          setViewing(true);
          if (result.room) game.attach(result.room, target);
        } catch (error) {
          if (joining.current !== pending || cancellation.current) return;
          if (
            (error instanceof MatchError || error instanceof PlayRequestError) &&
            error.status < 500
          ) {
            joining.current = null;
            setUncertain(false);
          } else setUncertain(true);
          throw error;
        }
      }),
    resume: () =>
      run(async (isCurrent) => {
        const result = await restore(game.roomInstanceId);
        if (!isCurrent() || cancellation.current) return;
        if (result.operationId === joining.current?.operationId) {
          joining.current = null;
          setUncertain(false);
        }
        if (result.room) game.attach(result.room, result.instanceId);
        setRestored(false);
        setViewing(true);
      }),
    cancel: () => {
      if (cancellation.current) return;
      const pending = joining.current;
      if (!pending)
        return run(async (isCurrent) => {
          if (game.roomId)
            await request(
              mode === 'casual' ? API_PATHS.casualCancel : API_PATHS.matchCancel,
              { room: game.roomId },
              game.roomInstanceId,
            );
          if (isCurrent() && currentGame.current.roomId === game.roomId) game.leave();
        });
      cancellation.current = {
        body: { operationId: pending.operationId },
        instanceId: pending.instanceId,
        ...(game.roomId && (!game.snapshot || game.snapshot.phase === 'WAITING')
          ? { previous: { room: game.roomId, instanceId: game.roomInstanceId } }
          : {}),
      };
      operation.current++;
      setCancelAttempt((attempt) => attempt + 1);
    },
  };
}
