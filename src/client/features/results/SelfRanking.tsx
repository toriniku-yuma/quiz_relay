import type { ResultsOverview } from '../../../shared/results';

export default function SelfRanking({ value }: { value: ResultsOverview['self'] }) {
  if (!value) return null;
  return (
    <p className="my-4 flex flex-wrap gap-x-6 gap-y-2 font-bold">
      <span>あなたの順位：{value.rank === null ? '—' : `${value.rank}位`}</span>
      <span>レート：{value.rating}</span>
    </p>
  );
}
