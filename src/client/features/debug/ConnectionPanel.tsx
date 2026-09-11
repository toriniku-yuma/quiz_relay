import { API_PATHS } from '../../../shared/api-paths';
import Button from '../../components/Button';
import Panel from '../../components/Panel';
import TextField from '../../components/TextField';
import type { DebugController } from './useDebug';

export default function ConnectionPanel({ debug }: { debug: DebugController }) {
  return (
    <Panel title="検証API">
      <form onSubmit={(event) => event.preventDefault()}>
        <TextField
          id="token"
          label="検証トークン（この画面のメモリ内だけで使用）"
          type="password"
          autoComplete="off"
          value={debug.token}
          onChange={(event) => debug.setToken(event.target.value)}
        />

        <div className="flex flex-wrap gap-3">
          <Button disabled={debug.busy} onClick={() => debug.request(API_PATHS.health)}>
            疎通確認
          </Button>

          <Button disabled={debug.busy} onClick={() => debug.request(API_PATHS.status)}>
            設定状態
          </Button>

          <Button
            disabled={debug.busy}
            onClick={() => debug.request(API_PATHS.durableObject, 'POST')}
          >
            DOに保存・5秒後にAlarm
          </Button>

          <Button
            disabled={debug.busy}
            onClick={() => debug.request(API_PATHS.durableObject)}
          >
            DO状態を取得
          </Button>

          <Button
            disabled={debug.busy}
            onClick={() => debug.request(API_PATHS.signature, 'POST')}
          >
            署名を検証
          </Button>

          <Button
            disabled={debug.busy}
            onClick={() => debug.request(API_PATHS.database, 'POST')}
          >
            DBのcommit・rollback
          </Button>
        </div>
      </form>
    </Panel>
  );
}
