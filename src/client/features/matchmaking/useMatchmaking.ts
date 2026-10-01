import { useEffect, useRef, useState } from 'react';
import { API_PATHS } from '../../../shared/api-paths';
import { useGame } from '../game/useGame';
import { PlayRequestError, playRequest } from '../rooms/api';
import { MatchError, matchRequest, resumeMatch } from './api';

export function useMatchmaking(
  subject: string,
  instanceId = '',
  mode: 'ranked' | 'casual' = 'ranked',
) {
  const request =
    mode === 'casual'
      ? playRequest<{
          room?: string;
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
  const [busy, setBusy] = useState(false);
  const [restoring, setRestoring] = useState(true);
  const [players, setPlayers] = useState<number | null>(null);
  const [rules, setRules] = useState<{
    correctAnswersToWin: number;
    mistakesToDisqualify: number;
  } | null>(null);
  const [error, setError] = useState('');
  const [activeInstance, setActiveInstance] = useState('');
  const operation = useRef(0);
  useEffect(() => {
    let active = true;
    const restoringOperation = ++operation.current;
    void request(
      mode === 'casual' ? API_PATHS.casualConfig : API_PATHS.matchConfig,
      {},
      instanceId,
    )
      .then((config) => {
        if (active && config.playersPerMatch) setPlayers(config.playersPerMatch);
        if (active && config.rules) setRules(config.rules);
      })
      .catch((error: unknown) => {
        if (active)
          setError(
            error instanceof Error ? error.message : '出題設定を読み込めませんでした。',
          );
      });
    void (
      mode === 'casual' && !subject
        ? Promise.resolve({ room: undefined })
        : mode === 'casual'
          ? request(API_PATHS.casualResume, {}, instanceId)
          : resumeMatch(instanceId)
    )
      .then((result) => {
        if (active && operation.current === restoringOperation && result.room)
          attach(result.room);
      })
      .catch((error) => {
        if (!active || operation.current !== restoringOperation) return;
        if (
          (error instanceof MatchError || error instanceof PlayRequestError) &&
          error.code === 'NO_ACTIVE_MATCH'
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
  }, [attach, leave, instanceId, mode, request, subject]);
  async function run(task: () => Promise<void>) {
    operation.current++;
    setBusy(true);
    setError('');
    try {
      await task();
    } catch (error) {
      setError(error instanceof Error ? error.message : '通信に失敗しました。');
      if (error instanceof MatchError) setActiveInstance(error.instanceId ?? '');
    } finally {
      setBusy(false);
    }
  }
  return {
    game,
    busy: busy || restoring,
    players,
    rules,
    error,
    activeInstance,
    join: (name: string) =>
      run(async () => {
        const result = await request(
          mode === 'casual' ? API_PATHS.casualJoin : API_PATHS.matchJoin,
          { name },
          instanceId,
        );
        if (result.room) game.attach(result.room);
      }),
    resume: () =>
      run(async () => {
        const result = await (mode === 'casual'
          ? request(API_PATHS.casualResume, {}, instanceId)
          : resumeMatch(instanceId));
        if (result.room) game.attach(result.room);
      }),
    cancel: () =>
      run(async () => {
        if (game.roomId)
          await request(
            mode === 'casual' ? API_PATHS.casualCancel : API_PATHS.matchCancel,
            { room: game.roomId },
            instanceId,
          );
        game.leave();
      }),
  };
}
