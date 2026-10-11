import { useApp } from '../app/context';
import { FEDERATION_PATH } from '../app/paths';
import Button from '../components/Button';
import FederationAdmission from '../features/federation/FederationAdmission';
import FederationPolicies from '../features/federation/FederationPolicies';
import PeerSettings from '../features/federation/PeerSettings';
import ResultDeliveries from '../features/federation/ResultDeliveries';
import { useFederation } from '../features/federation/useFederation';

export default function FederationPage() {
  const { organization, url } = useApp();
  const allowed = organization.data?.account?.administrator === true;
  const federation = useFederation(allowed);
  const instanceId = url.searchParams.get('instance') ?? '';
  const instance = organization.data?.instances.find((row) => row.id === instanceId);
  return (
    <main className="mx-auto max-w-5xl p-4 md:p-8">
      <h1 tabIndex={-1} className="mb-4 text-3xl font-bold outline-none">
        {instanceId ? '問題・結果の共有設定' : '外部組織との連携'}
      </h1>
      {instance && <p>{instance.name}</p>}
      {!allowed ? (
        <p>組織管理者が設定できます。</p>
      ) : (
        <>
          {federation.error && (
            <p role="alert" className="my-4 border border-accent p-3">
              {federation.error}
            </p>
          )}
          {federation.error && (
            <Button disabled={federation.busy} onClick={federation.refresh}>
              再試行
            </Button>
          )}
          {!federation.data ? (
            <p role="status">連携設定を読み込んでいます。</p>
          ) : !instanceId ? (
            <div className="grid gap-5">
              <FederationAdmission
                key={federation.data.admission.revision}
                federation={federation}
              />
              <PeerSettings federation={federation} />
            </div>
          ) : instance ? (
            <div className="grid gap-5">
              <p>
                相手組織の登録・承認・対戦参加の制限は、
                <a className="underline" href={FEDERATION_PATH}>
                  外部組織との連携
                </a>
                で設定します。
              </p>
              <FederationPolicies
                key={instance.id}
                instanceId={instance.id}
                federation={federation}
              />
              <ResultDeliveries instanceId={instance.id} federation={federation} />
            </div>
          ) : (
            <p className="my-4">対象インスタンスを確認してください。</p>
          )}
        </>
      )}
    </main>
  );
}
