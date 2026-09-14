# DrizzleによるDB管理

2026-09-14。Drizzle ORM 0.45.2 / Drizzle Kit 0.31.10を固定し、既存Postgres.js接続を利用する。ゲーム読込・設定反映・初期投入・DBプローブはDrizzleの型付きAPIを使う。SQLの文字列連結、自前エスケープ、通常処理からのSupabase Management APIへのSQL送信を撤去した。

## 日常のコマンド

| 操作 | コマンド |
| --- | --- |
| ローカルの人数・ルールを反映 | `pnpm config:apply:local` |
| 標準の人数・ルールを反映 | `pnpm config:apply:default` |
| テーブル定義変更からmigrationを生成 | `pnpm db:generate --name=変更名` |
| 必要なカスタムmigrationを作成 | `pnpm db:generate:custom --name=変更名` |
| 未適用migrationをDBへ反映 | `pnpm db:migrate` |
| 実DBで反映・rollback・権限を検証 | `pnpm db:check` |
| 初期投入内容を検証・要約表示 | `pnpm db:seed` |
| 空のカタログへ初期投入 | `pnpm db:seed config/matchmaking.json --apply` |

通常の人数変更ではmigrationを作らない。[JSON設定手順](configuration.md)を使う。初期seedは適用済みDBへ再投入しない。重複時は上書きせずトランザクション全体が失敗する。問題の改訂・管理UIは後続段階。

## 配置と権限

- `src/worker/db/schema.ts`：対象8テーブル、FK、CHECK、RLSを定義。既存DBから取り込み、制約名を保持。
- `src/worker/db/connection.ts`：Drizzle＋Postgres.js接続。TLS、prepared statements無効、接続の解放を共通化。
- `drizzle.config.ts`：対象スキーマをquiz_game・quiz_probeに限定。Supabaseのauth等は管理しない。
- `drizzle/`：生成SQL・カスタムSQL・snapshot・journal。実DBの適用履歴は `drizzle.__drizzle_migrations`。

アプリは従来の `GAME_DATABASE_URL` / `GAME_HYPERDRIVE` とquiz_game_readerを使い、SELECTだけを許可する。

`.env.supabase-admin` の `GAME_CONFIG_DATABASE_URL` はCLI専用のquiz_game_config接続。カタログSELECT、ルール版・大会版・有効設定のINSERT、有効設定のUPDATEだけを許可する。問題の変更、過去版のUPDATE/DELETE、スキーマ変更は許可しない。

`GAME_MIGRATION_DATABASE_URL` はDDLと初期投入のための管理接続。設定更新用と分離する。管理接続はSupabaseのセッションプール（この環境は5432）または直接接続を使う。トランザクションプールでのKit introspectionはこの環境で完了しなかったため使用しない。接続例のキーは `.env.example`、秘密値は `.env.supabase-admin`、共通CAは `.dev.vars`。これらの管理接続をWorker bindingへ入れない。既存PATは保持するが通常のDBコマンドは使わない。

この環境の接続設定・新規ロールの資格情報登録は完了済み。別環境では新規roleのパスワードを安全な管理手順で設定する。パスワードはmigrationへ埋め込まない。

## SQLを残す範囲

通常のselect/insert/update/delete、JOIN、upsert、トランザクションはDrizzle APIを使う。独自ラッパーでSQLの文字列置換を行わない。

1. テーブル・FK・RLSのSQLはDrizzle Kitが生成する。手書きしない。
2. 既存DBから取り込んだCHECK式とRLSのtrue式は、Drizzleスキーマ内の `sql` 式として保持する。
3. トリガー関数・LOGINロールのオプション・GRANT/REVOKEはカスタムmigration。PostgreSQL固有機能に限定する。
4. 設定反映の開催元単位のtransaction advisory lockは、1か所のパラメーター化されたDrizzle `sql` 呼出し。読取ロール試験のcurrent_user照会も固定SQL。

旧supabase/migrations、2人版seed SQL、SQL権限試験はDrizzle側へ移行したため削除済み。migrationはdrizzle/、2人設定はconfig:apply:local、権限・RLS・不変版の試験はscripts/check-game-permissions.mjsを含むpnpm db:checkへ一本化した。過去の適用記録は検証記録に残す。

## 既存DBの引継ぎ

このDBでは旧SQLがSupabase CLI履歴に登録されていなかった。Drizzle Kit pullで8テーブルを取得し、カラム・制約・FK・ポリシーを生成snapshotと照合した。取り込みのRLS明示フラグは補完し、実際の生成DDLも全8テーブルでENABLEを確認した。旧SQLテスト、5つの不変トリガーと関数内容も照合済み。

`0000_existing_catalog` と `0001_existing_security` だけを検証後に適用済み登録した。既存テーブルを再作成していない。その後 `0002_config_writer`、`0003_config_policies`、`0004_explicit_rls` をDrizzle migratorで適用した。再度 `db:migrate` して未適用なし、`db:generate` で構造変更なしを確認。

新規環境には全migrationを順に適用する。既存DBへ移行する別環境では、既存構造を同様に照合するまで初期migrationを実行しない。今回のベースライン登録用スクリプトはこの環境専用であり、再実行しない。

## 検証

通常の `pnpm run check` に加え、`pnpm db:check` は実DBを使う。変更版作成と繰返し適用を専用writerのTXで実行してrollbackし、別接続での同時反映は一時プロファイルだけを作って削除する。既存問題・固定版・default/localは変更しない。実DBの検証中に別の管理者が設定を変更すると件数検査は失敗するため、単独で実行する。

今回の新規DDL検証は全migrationのスキーマ・ロール名を隔離名へ置換し、実Postgresの1トランザクション内で全statementを実行してrollbackした。空環境への構造作成は検証済みだが、新規プロジェクトでのAuth・接続設定・初期seedまでの全手順E2Eとは区別する。クラウド配置は未実施。

- [DrizzleのPostgreSQL接続](https://orm.drizzle.team/docs/connect-supabase)
- [DrizzleのRLS](https://orm.drizzle.team/docs/rls)
- [カスタムmigration](https://orm.drizzle.team/docs/kit-custom-migrations)
