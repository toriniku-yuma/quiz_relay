import Button from '../../components/Button';
import Panel from '../../components/Panel';
import type { DebugController } from '../debug/useDebug';
import { canAuthenticate } from './client';

export default function AuthPanel({ debug }: { debug: DebugController }) {
  const secure = canAuthenticate();

  return (
    <Panel title="ログイン遷移">
      <p className="mt-3">
        Googleログインで本人確認します。検証後はログアウトしてください。
      </p>

      {!secure && (
        <p className="mt-3" role="status">
          ログインにはHTTPSまたはlocalhostが必要です。
        </p>
      )}

      <div className="mt-4 grid gap-4">
        <div className="flex flex-wrap gap-3">
          <Button
            tone="primary"
            disabled={debug.busy || !secure}
            onClick={debug.googleLogin}
          >
            Googleでログイン
          </Button>

          <Button disabled={debug.busy} onClick={debug.checkIdentity}>
            本人確認
          </Button>

          <Button disabled={debug.busy} onClick={debug.signOut}>
            ログアウト
          </Button>
        </div>
      </div>
    </Panel>
  );
}
