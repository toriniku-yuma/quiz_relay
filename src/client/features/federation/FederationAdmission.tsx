import { useState } from 'react';
import Button from '../../components/Button';
import Panel from '../../components/Panel';
import type { useFederation } from './useFederation';

export default function FederationAdmission({
  federation,
}: {
  federation: ReturnType<typeof useFederation>;
}) {
  const admission = federation.data?.admission;
  const [mode, setMode] = useState(admission?.mode ?? 'approved');
  return (
    <Panel title="外部組織からの参加">
      <form
        className="grid gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void federation.mutate({
            operation: 'admission',
            mode,
            revision: admission?.revision,
          });
        }}
      >
        <label htmlFor="federation-admission" className="grid gap-2">
          参加を許可する組織
          <select
            id="federation-admission"
            value={mode}
            onChange={(event) => setMode(event.target.value as typeof mode)}
            className="h-12 border border-line bg-input p-2"
          >
            <option value="approved">承認済みの組織だけ許可</option>
            <option value="unblocked">禁止した組織以外は許可</option>
          </select>
        </label>
        <p>
          この組織が開催する対戦に適用します。相手組織ごとの禁止と対戦種別の制限は、どちらの方式でも優先します。
        </p>
        <p className="text-sm">
          広く参加を許可しても、問題共有の承認・許可は変わりません。
        </p>
        <Button type="submit" disabled={federation.busy || mode === admission?.mode}>
          参加方式を保存
        </Button>
      </form>
    </Panel>
  );
}
