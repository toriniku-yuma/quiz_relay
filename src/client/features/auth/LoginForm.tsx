import { useState } from 'react';
import Button from '../../components/Button';
import Panel from '../../components/Panel';
import TextField from '../../components/TextField';
import { canAuthenticate } from './client';
import type { Auth } from './useAuth';

export default function LoginForm({ auth }: { auth: Auth }) {
  const [email, setEmail] = useState('');
  return (
    <Panel title="ログインして参加">
      <p className="mt-3">メールまたはGoogleアカウントでログインしてください。</p>
      {!canAuthenticate() && (
        <p role="alert" className="mt-3">
          ログインにはHTTPS接続が必要です。
        </p>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void auth.email(email);
        }}
      >
        <TextField
          id="login-email"
          label="メールアドレス"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          required
        />
        <div className="flex flex-wrap gap-3">
          <Button
            type="submit"
            tone="primary"
            disabled={auth.busy || !auth.ready || !canAuthenticate()}
          >
            ログインメールを送信
          </Button>
          <Button
            onClick={auth.google}
            disabled={auth.busy || !auth.ready || !canAuthenticate()}
          >
            Googleでログイン
          </Button>
        </div>
      </form>
    </Panel>
  );
}
