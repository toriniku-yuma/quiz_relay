export default function PlayerName({
  player,
}: {
  player?: { name: string; serverName?: string | null };
}) {
  if (!player) return null;
  return (
    <>
      {player.name}
      {player.serverName && (
        <small className="ml-2 font-normal">（{player.serverName}）</small>
      )}
    </>
  );
}
