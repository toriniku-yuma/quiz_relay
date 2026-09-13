import { useEffect, useRef } from 'react';
import Button from '../../components/Button';
import type { Game } from './useGame';

export default function AnswerPanel({ game }: { game: Game }) {
  const firstChoice = useRef<HTMLButtonElement>(null);
  const panel = game.panel;

  const panelId = panel?.panelId;

  useEffect(() => {
    if (panelId) firstChoice.current?.focus();
  }, [panelId]);

  if (!panel) return null;

  const paused = game.snapshot?.reconnect;
  const remaining = Math.max(
    0,
    paused ? (paused.remaining ?? 0) / 1000 : (panel.deadline - game.clock) / 1000,
  );
  return (
    <section className="mt-6 border-2 border-accent p-4" aria-label="文字を選ぶ">
      <p className="mb-4 font-bold">
        {panel.position + 1}文字目を選択{' '}
        <span className="ml-3 tabular-nums">残り {remaining.toFixed(1)} 秒</span>
      </p>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        {panel.choices.map((choice, index) => (
          <Button
            ref={index === 0 ? firstChoice : undefined}
            key={choice.id}
            className="min-h-20 text-3xl"
            disabled={
              game.connection !== 'open' || game.pending || remaining === 0 || !!paused
            }
            onClick={() =>
              game.send('choose', {
                attemptId: panel.attemptId,
                panelId: panel.panelId,
                choiceId: choice.id,
              })
            }
          >
            {choice.text}
          </Button>
        ))}
      </div>
    </section>
  );
}
