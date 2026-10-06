# ローカルPostgreSQL

[ドキュメント一覧](../README.md)

通常の起動は pnpm dev。初回準備と停止方法は「起動・停止」を確認してください。

<a id="local-postgres-001"></a>
## ローカル開発用PostgreSQL

通常のローカル起動はPC内のPostgreSQLを使用する。Supabaseのプロジェクト・DB・Authユーザー・OAuth設定は保持し、クラウド初期化は取りやめた。

Docker・Windowsサービス登録は不要。

<a id="local-postgres-002"></a>
## このPCの構成

| 対象 | 設定 |
| --- | --- |
| PostgreSQL | 17.11、Windows ZIP版。既存の `.wrangler/pg-local/pgsql/bin` を再利用 |
| 接続先 | `127.0.0.1:55432/quiz_relay_dev`。外部インターフェースでは待受しない |
| データ | `.wrangler/postgres-dev/data`。停止・再起動で保持 |
| DB構造 | Drizzle migration 0000〜0051適用済み。既存の初回設定・問題・権限・戦績を保持。アカウント別の切替候補は空から開始 |
| 認証 | 各DBロールに個別のランダムパスワード、SCRAM-SHA-256 |
| ローカル秘密 | `.env.postgres-local`。管理接続・CLI用を含むため公開しない |
| Worker接続 | `.dev.vars` のprobe／reader／results／organization専用接続だけをローカルへ変更 |
| 退避 | `.wrangler/postgres-dev/dev-vars-before-local` に切替前の.dev.varsを保持 |
| Supabase Auth | 既存のURL・公開キー・OAuth設定を維持。認証自体は引き続きSupabaseへ接続 |

管理者接続をWorkerへ渡さない。DB資格情報とSupabaseのログインユーザーは別。`.env*`・`.dev.vars`・`.wrangler/`はGit除外対象。

空環境でもmigration履歴やPostgreSQL内部情報は存在する。

<a id="local-postgres-003"></a>
## 起動・停止

プロジェクト直下のPowerShellで実行する。

```powershell
# 初回、またはローカルDBへ追加migrationを適用する時
pnpm db:local:setup

# PostgreSQLを起動してから既存のVite設定でアプリを起動
pnpm dev

# DBだけの起動・接続／権限チェック・停止
pnpm db:local:start
pnpm db:local:check
pnpm db:local:stop
```

`setup`は既存データを消さず、migrationと専用接続設定を整える。既存のSupabase Auth・HTTPS証明書・初回管理者指定を保持する。

`start`は.dev.varsのDB接続が専用ローカル設定と一致することを確認し、違えば停止する。削除・リセットコマンドは用意していない。

ViteをCtrl+Cで終了してもPostgreSQLは動作を継続する。作業終了時に `db:local:stop` を実行する。Windows再起動後は `pnpm dev` がDBを起動する。

既存の5173番サーバーは勝手に停止しない。起動済みなら利用者側で止めて `pnpm dev` で再起動する。.dev.vars変更前のプロセスに古い接続が残る可能性がある。

今回のHTTP検証は5174番の別プロセスで行い、検証後にそのプロセスだけ停止した。

<a id="local-postgres-007"></a>
## 空環境での初回設定

- `.dev.vars` では `ORGANIZATION_ENABLED=true`、`GAME_CONFIG_PROFILE=local` に設定する。
- `/game/`で既存のSupabase Authにログインし、初回設定画面の本人識別子を確認する。設置者が `.dev.vars` の `INITIAL_ADMIN_SUBJECT` に設定してサーバーを再起動する。

  自動で特定の既存ユーザーを管理者に選ばない。
- 初回設定で組織と最初のインスタンスを作る。問題と出題設定は未登録のため、DB準備だけで通常対戦が始まる状態ではない。
- SupabaseのAuth callbackは既存登録済みのoriginを利用する。今回URLの追加登録やログインユーザーの作成・削除は行っていない。

<a id="local-postgres-008"></a>
## ローカルDBに対するCLI操作

既存の `db:migrate`、`db:seed`、`config:apply`、`catalog:manage` 等のnpmスクリプトは `.env.supabase-admin` を読むため、**ローカルDB用としてそのまま実行しない**。

ローカル用資格情報だけを読み込む形で既存スクリプトを実行する。

新規初回設定・追加で作ったインスタンスのownerは `urn:uuid:<インスタンスID>`。設定JSONのownerを対象と一致させてからプレビューする。既存の `config/matchmaking.local.json` のownerをそのまま別インスタンスへ流用しない。以下のJSONパスは、対象用に用意したファイルへ置き換える。

```powershell
# 問題のプレビュー（DB変更なし）
node --env-file=.env.postgres-local scripts/game-catalog-seed.ts config/matchmaking.local.json

# 必要になった時だけサンプル問題を投入（再投入用ではない）
node --env-file=.env.postgres-local scripts/game-catalog-seed.ts config/matchmaking.local.json --apply
node --env-file=.env.postgres-local scripts/apply-game-config.ts config/matchmaking.local.json local --apply
```

初回環境構築だけではseedを投入しません。catalog管理ロールのLOGINは作成済みだが、ownerへの対応付けは空なので、対象インスタンスの専用資格情報を次のコマンドで用意する。

```powershell
node --env-file=.env.postgres-local scripts/setup-instance-catalog.ts <インスタンスID> --apply
```

管理CLIは `.env.postgres-local` と生成された `.env.catalog.<インスタンスID>` をこの順で読み込んで実行する。後続の管理画面を実装済みとして扱わない。

<a id="local-postgres-011"></a>
## 接続の境界

`connectDatabase`は `localhost`／`127.0.0.1`／`[::1]` かつURLに `sslmode=disable` が明示された場合だけ、直接接続のTLSを無効にする。

外部ホストでは引き続き証明書検証を要求する。Hyperdrive経由の扱いは従来どおり。DBプローブもローカル接続を `local-plaintext` と表示し、TLS検証済みと誤表示しない。

Cloudflare配信・Hyperdrive設定は変更していない。この設定のままクラウドへデプロイするための手順ではない。公開前に実環境用のDB接続・組織初期化・Authを別途構成・確認する。

<a id="local-postgres-012"></a>
## 別PCで用意する場合

Windows版PostgreSQLの実行ファイル（bin・lib・shareが揃ったZIP展開先）を用意し、`LOCAL_PG_BIN` にbinの絶対パスを設定して `pnpm db:local:setup` を実行する。

スクリプトはWindows用で、ダウンロード・OSサービス登録・既存クラスタの削除は行わない。既定ポート55432が使用中なら既存サービスを勝手に停止せず、競合を解消してから起動する。

[実施結果](../history/verification.md)／[検証項目](../development/testing.md)

<a id="local-postgres-013"></a>
## 設定できたかを画面で確認する

`/debug/` の「現在の組織・インスタンス設定」で、ログイン本人の名前、組織名、管理者権限、本人識別子、閲覧できるインスタンス名と公開／準備中状態を確認できる。

「設定を再確認」で最新情報を取得し、「組織設定・インスタンス一覧を開く」から初回設定・管理へ移動する。

管理者名はログイン本人が組織管理者の場合に表示する。現在は管理者専用の名前をDBへ保存していないため、Authの表示名（未登録なら本人メール）を表示し、権限は組織DBで別に判定する。

他ユーザーのAuth情報を取得・公開する機能ではない。未ログイン、初回設定未完了、組織機能無効、取得失敗を区別する。組織とインスタンスの表示成功は、出題設定や対戦準備の完了までは意味しない。

<a id="local-postgres-014"></a>
## 初期設定画面が出ない場合

`/debug/` に「組織機能が無効です」と出る場合は、`.dev.vars` の `ORGANIZATION_ENABLED` と `ORGANIZATION_DATABASE_URL` を確認する。

同じキーの重複があると末尾の値が優先される。`pnpm db:local:setup` は重複した設定行も更新する。実行後、起動中のViteを終了し `pnpm dev` で再起動して `/game/` を開く。

`start` は組織機能の無効化や専用DB接続の不一致を検出し、修復コマンドを表示する。

`INITIAL_ADMIN_SUBJECT` の指定は初回設定を実行できる本人の指定であり、組織作成の完了ではない。その本人でログインし、初回設定フォームから組織と最初のインスタンスを作成すると管理者登録が完了する。
