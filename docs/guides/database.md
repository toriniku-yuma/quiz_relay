# DBの変更・検証

[ドキュメント一覧](../README.md)

**通常アプリはCloudflare D1を使用します。ローカル開発もD1です。**
DrizzleのSQLiteスキーマとD1 bindingを使用します。PostgreSQLへの接続は移行元を読むツールだけに残し、旧DB原本を保持しています。

<a id="database-002"></a>
## 日常のコマンド

| 操作 | コマンド |
| --- | --- |
| ローカルD1へmigrationを反映 | `pnpm db:migrate --local` |
| 通常WorkerのクラウドD1へ反映 | `pnpm db:migrate --remote` |
| スキーマからmigrationを生成 | `pnpm db:generate --name=変更名` |
| trigger等のcustom migrationを作成 | `pnpm db:generate:custom --name=変更名` |
| 隔離した実D1で機能・制約を検証 | `pnpm db:check` |
| 初期投入のプレビュー | `pnpm db:seed` |
| 空のローカルカタログへ初期投入 | `pnpm db:seed config/matchmaking.json --apply` |
| ローカル人数・ルールを反映 | `pnpm config:apply:local` |
| 標準プロファイルへ反映 | `pnpm config:apply config/matchmaking.json default --apply` |

通常Workerと消去Workerは同じD1 IDと `.wrangler/state/v3/d1` を使用します。クラウドとローカルは別DBです。A/B検証には専用Wrangler設定と環境名を指定し、通常Worker向けコマンドを流用しません。
人数・ルールは[設定手順](configuration.md)、投稿・審査はWeb画面、初期構築用の問題登録は[管理CLI](catalog.md)を使用します。既存DBへ初期seedを上書きしません。

<a id="database-003"></a>
## 配置と認可

| 配置 | 役割 |
| --- | --- |
| `src/worker/db/schema.ts` | SQLiteのテーブル・外部キー・CHECK・index |
| `src/worker/db/d1.ts` | Drizzle D1接続、整合した読取り、競合検査付きatomic batch |
| `drizzle.config.ts`・`drizzle.d1.config.ts` | 同じD1スキーマとmigration出力先 |
| `drizzle-d1/` | D1のmigration・snapshot・journal |
| `scripts/local-d1.ts` | CLIから通常開発環境と同じローカルD1へ接続 |
| `scripts/legacy-postgres/` | 旧PostgreSQLのスキーマ・読取り・コピー・照合 |
| `drizzle/` | 旧PostgreSQL履歴。D1へ適用しない |

D1にはPostgreSQLのLOGINロールやRLSを移植しません。ブラウザーへDB接続を渡さず、Workerが本人・組織・インスタンス・操作権限を検証します。公開API、非公開の消去Worker、設置者のローカルCLIを分けます。管理CLIでも `CATALOG_SUBJECT` または `INITIAL_ADMIN_SUBJECT` と対象ownerを照合し、組織管理者以外の更新を拒否します。

<a id="database-004"></a>
## SQLと更新

通常処理はDrizzleの型付きAPIを使用します。JSON集計等はパラメーター化された `sql` 式、制約・不変保護はcustom migrationに置きます。SQL文字列の連結、独自escape、Management APIへの通常SQL送信はしません。
D1のbatchは全体成功または全体rollbackです。更新前の読取りで計画を作り、batchでrevisionを照合します。競合時は計画から再試行し、計画内で外部通信しません。読取りも前後のrevisionを検査します。
一括入力はDrizzle変換後のJSONサイズを測って分割し、定期処理・照合・削除は少数件ずつ進捗を保存します。

<a id="database-005"></a>
## 旧PostgreSQLからの移行と復旧

`pnpm db:rehearse:d1` は `.env.postgres-local` の `127.0.0.1:55432/quiz_relay_dev` だけを読取り専用の一貫したスナップショットで取得します。既存DB・DO・Authへ書き込みません。

1. 全42テーブルの原文をGit対象外の `.wrangler/d1-migration/ランダムID/backup.json` へ保存し、SHA-256を記録します。
2. 新しい隔離D1へ全migrationとデータを適用します。日時精度・JSON・真偽値を保ち、検索列・難易度集計・消去処理の追加情報を補います。
3. 全42テーブルの件数・内容hash、`quick_check`、`foreign_key_check` を照合し、`verification.json` に保存します。端末には件数と判定だけを表示します。

実際のローカル切替は通常アプリの書込み停止後に `node scripts/cutover-local-d1.ts 検証済みバックアップディレクトリ --apply` を実行します。検証済みhash・空の移行先・移行元を確認し、設定とDO保存ディレクトリを退避して、コピー後に再照合します。非空のD1へ再適用しません。
ローカルD1への切替と照合は完了しています。旧DB・退避データは保持しています。移行ごとの件数とhashはGit管理外の検証出力で扱います。クラウドへの本データ移送は別作業です。

復旧では一般アクセス・書込みを止め、切替前のDB・設定・DOを同じ組として復元します。切替後の退会・削除の独立記録を適用し、[消去と部屋照合](operations.md#消去記録とバックアップ復元)を完了してから公開します。旧DBへの再接続だけでは切替後の更新を復旧できません。
バックアップは個人情報・秘密設定を含み、Git・公開ログ・チャットへ出しません。[旧PostgreSQL手順](local-postgres.md)は移行元の維持にだけ使用します。

<a id="database-006"></a>
## 検証

`pnpm db:check` は通常データと独立した実D1で、全migration、カタログ、結果、作問、モデレーション、部屋、退会・削除、難易度、定期処理、部屋照合を確認します。不変性、rollback、二重加算防止、対象・本人の分離も検証します。
通常APIで作った組織と実GameRoom DOを接続し、結果保存・本人履歴・順位・第三者への非公開を確認します。外部本人確認だけを隔離用の応答へ置き換え、実アカウントを退会させません。
`pnpm run check` は型・静的検査・全自動試験・設定検査・ビルドを行います。公開A/Bと実ブラウザーの受入は[検証項目](../development/testing.md)で区別します。

<a id="database-007"></a>
## 結果保存

結果・参加者の確定差分・配送原本を同じbatchで保存します。同じID・同じ内容の再試行だけを成功扱いにし、同じ試合の別結果IDや異なる内容は競合とします。失敗時はDOに原本と再試行予定を残します。
不変triggerは上書き・削除を拒否します。匿名化・期限処理・受付済み完全削除だけを制約で許可し、名前の消去でも確定レート・勝敗を変えません。通常APIからoutbox原本を公開しません。

<a id="database-008"></a>
## カタログ管理

問題登録・改訂・停止・セット作成・設定反映は、対象ownerと組織管理者を確認します。過去版を更新せず、旧問題の停止と新しい版・有効参照を同じbatchで保存します。Webの作問・審査権限は管理CLIと別に確認します。
