import { useEffect, useState } from 'react';
import { API_PATHS } from '../../../shared/api-paths';
import { useGame } from '../game/useGame';
import { MatchError, matchRequest, resumeMatch } from './api';

export function useMatchmaking(subject: string) {
  const game = useGame('formal', subject);
  const { attach, leave } = game;
  const [busy, setBusy] = useState(false);
  const [restoring, setRestoring] = useState(true);
  const [players, setPlayers] = useState<number | null>(null);
  const [rules, setRules] = useState<{
    correctAnswersToWin: number;
    mistakesToDisqualify: number;
  } | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    void matchRequest(API_PATHS.matchConfig)
      .then((config) => {
        if (active && config.playersPerMatch) setPlayers(config.playersPerMatch);
        if (active && config.rules) setRules(config.rules);
      })
      .catch(() => {
        if (active)
          setError('大会設定を読み込めませんでした。しばらく待って再試行してください。');
      });
    void resumeMatch()
      .then((result) => {
        if (active && result.room) attach(result.room);
      })
      .catch((error) => {
        if (!active) return;
        if (error instanceof MatchError && error.code === 'NO_ACTIVE_MATCH') leave();
        else setError(error.message);
      })
      .finally(() => {
        if (active) setRestoring(false);
      });
    return () => {
      active = false;
    };
  }, [attach, leave]);
  async function run(task: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await task();
    } catch (error) {
      setError(error instanceof Error ? error.message : '通信に失敗しました。');
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
    join: (name: string) =>
      run(async () => {
        const result = await matchRequest(API_PATHS.matchJoin, { name });
        if (result.room) game.attach(result.room);
      }),
    resume: () =>
      run(async () => {
        const result = await resumeMatch();
        if (result.room) game.attach(result.room);
      }),
    cancel: () =>
      run(async () => {
        if (game.roomId) await matchRequest(API_PATHS.matchCancel, { room: game.roomId });
        game.leave();
      }),
    logout: async () => {
      if (game.roomId) await matchRequest(API_PATHS.matchLogout, { room: game.roomId });
      game.leave();
    },
  };
}
