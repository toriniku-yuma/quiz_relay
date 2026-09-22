# DrizzleによるDB管理

2026-09-15追加要望：オーガナイゼーションで管理者・ユーザーを共有し、その中に複数のインスタンスを設ける構成を検討する。モデレーター・作問・レート・マッチング・部屋はインスタンス単位。従来のインスタンスごとにDB・Auth・管理者を独立配置する前提は見直し対象。1回のセルフホスト構築で1オーガナイゼーションを用意し、配下インスタンスを管理画面から追加する方針は承認済み。問題等の連携はインスタンスごとに設定し、組織単位の一括許可は行わない。同組織内の参加は共通ユーザーとして扱い、インスタンス間の外部参加とは扱わない。別組織への参加は参加元・先のインスタンス間設定で判断する。対象を選んだ一括設定操作は用意する方向。基盤構成・連携契約の詳細、既存データの移行は未確定。[ADR 0011](adr/0011-organization-and-instances.md)と仕様書の最新要望を優先する。実装・DB操作は停止中。

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

## 2026-09-14：結果保存の追加

0005_result_writer、0006_match_results、0007_result_permissionsを隔離スキーマTXで検証後、Drizzleで適用。結果・参加者差分・outboxの3表を追加。quiz_game_resultsはこの3表のSELECT/INSERTだけ。readerは結果と参加者表のSELECTだけを追加し、outboxは読めない。anon/authenticatedへ公開しない。3表は不変トリガーで管理接続からのUPDATE/DELETEも拒否する。

ローカル専用RESULT_DATABASE_URLを.dev.varsに設定済み。新規ランダムパスワードを使い、管理資格情報をWorkerへ渡していない。Cloudflareへの新規writer資格情報登録・RESULT_HYPERDRIVE追加は未実施。既存reader Hyperdriveへ書込権限を追加しない。

`pnpm db:check:results:ddl` は隔離DDLをrollbackする。`pnpm db:check:results` は実commitと別接続同時再試行を検証し、毎回一意の `https://qa-<UUID>.invalid` ownerで3件の原本を保存する（不変保護を維持し、検証後も残す）。通常GAME_OWNERの履歴・ランキングへは表示しない。中断・失敗時も保存済み原本を削除しない。既存の問題・設定や通常試合を書き換えない。

## 2026-09-14：1D第二段の最小管理

専用CLIによる問題登録・改訂・停止、問題セット版作成、ルール/人数/使用セットの反映・一覧を実装した。quiz_game_catalogをcatalog_operatorsの開催元へ限定し、RLSと操作認可を適用する。新しい管理資格情報は.env.supabase-adminだけに保存し、Workerへは渡さない。設定writer・結果writer・reader・migration管理者は維持する。過去版は更新せず、改訂元の停止と新規IDの追加を同一TXで行う。手順・範囲は[最小管理](catalog-management.md)。


## 2026-09-16：第1段階の実装再開

組織共通の本人識別、専用DBロール、初回設定、インスタンス管理、対象ID付きAPI、組織共通予約とインスタンス別対戦・結果を追加した。[実装記録](organization-foundation-progress.md)の現行契約・有効化設定・移行と復旧の未実施事項を参照。追加migrationは0011〜0013、既存DBへの適用・クラウド配置は未実施。準備中テストと第1段階全体の受入は未完了。
