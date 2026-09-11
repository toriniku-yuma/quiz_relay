import Button from '../../components/Button';
import Panel from '../../components/Panel';
import TextField from '../../components/TextField';
import type { DebugController } from '../debug/useDebug';
import { canAuthenticate } from './client';

export default function AuthPanel({ debug }: { debug: DebugController }) {
  const secure = canAuthenticate();

  return (
    <Panel title="ログイン遷移">
      <p className="mt-3">
        メールリンクは同じブラウザーなら別タブでも開けます。検証後はログアウトしてください。
      </p>

      {!secure && (
        <p className="mt-3" role="status">
          ログインにはHTTPSまたはlocalhostが必要です。
        </p>
      )}

      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!debug.busy && secure) void debug.sendEmail();
        }}
      >
        <TextField
          id="email"
          label="メールアドレス"
          type="email"
          autoComplete="email"
          value={debug.email}
          onChange={(event) => debug.setEmail(event.target.value)}
          required
        />

        <div className="flex flex-wrap gap-3">
          <Button
            tone="primary"
            type="submit"
            disabled={debug.busy || !debug.email || !secure}
          >
            ログインメールを送信
          </Button>

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
      </form>
    </Panel>
  );
}
