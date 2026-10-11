import Button from '../../components/Button';
import Panel from '../../components/Panel';
import { canAuthenticate } from './client';
import type { Auth } from './useAuth';

export default function LoginForm({ auth }: { auth: Auth }) {
  return (
    <Panel title="ログインして参加">
      <p className="mt-3">Googleアカウントでログインしてください。</p>
      {!canAuthenticate() && (
        <p role="alert" className="mt-3">
          ログインにはHTTPS接続が必要です。
        </p>
      )}
      <div className="mt-4 grid gap-4">
        <div className="flex flex-wrap gap-3">
          <Button
            tone="primary"
            onClick={auth.google}
            disabled={auth.busy || !auth.ready || !canAuthenticate()}
          >
            Googleでログイン
          </Button>
        </div>
      </div>
    </Panel>
  );
}
