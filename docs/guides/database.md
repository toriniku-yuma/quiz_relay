# DBの変更・検証

[ドキュメント一覧](../README.md)

**通常アプリはCloudflare D1を使用します。ローカル開発もD1です。**
DrizzleのSQLiteスキーマとD1 bindingを使用します。

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
| 空のローカルカタログへ初期投入 | `pnpm db:seed --apply` |
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
| `drizzle.config.ts` | D1スキーマとmigration出力先 |
| `drizzle-d1/` | D1のmigration・snapshot・journal |
| `scripts/local-d1.ts` | CLIから通常開発環境と同じローカルD1へ接続 |

D1にはDBロールや行単位のアクセス制御がありません。ブラウザーへDB接続を渡さず、Workerが本人・組織・インスタンス・操作権限を検証します。公開API、非公開の消去Worker、設置者のローカルCLIを分けます。管理CLIでも必須の `CATALOG_SUBJECT` と対象ownerを照合し、組織管理者以外の更新を拒否します。

<a id="database-004"></a>
## SQLと更新

通常処理はDrizzleの型付きAPIを使用します。JSON集計等はパラメーター化された `sql` 式、制約・不変保護はcustom migrationに置きます。SQL文字列の連結、独自escape、Management APIへの通常SQL送信はしません。

`0002_foreign_login_grant` は外部ログインに継続参加の証明を追加します。適用時に既存の外部ログインを失効させるため、利用者は次の外部参加時に一度ログインし直します。参加予約・試合結果・会員データは削除しません。
D1のbatchは全体成功または全体rollbackです。更新前の読取りで計画を作り、batchでrevisionを照合します。競合時は計画から再試行し、計画内で外部通信しません。読取りも前後のrevisionを検査します。
一括入力はDrizzle変換後のJSONサイズを測って分割し、定期処理・削除は少数件ずつ進捗を保存します。

<a id="database-005"></a>
## バックアップと復旧

試合は待機時からD1に行を持ち、進行中の状態と未保存の裁定結果はDOに残ります。確定と終了通知後はDOを削除します。D1だけを戻しても、DOに残る未保存結果や復元時点より後の消去は回復できません。

1. 一般アクセスと書込みを止めます。
2. D1・DO保存・設定を同じ時点の組として復元します。
3. 復元時点より後の退会・削除の独立記録を適用し、[消去](operations.md#消去記録とバックアップ復元)を完了してから公開します。

バックアップは個人情報・秘密設定を含み、Git・公開ログ・チャットへ出しません。

<a id="database-006"></a>
## 検証

`pnpm db:check` は通常データと独立した実D1で、全migration、カタログ、結果、作問、モデレーション、部屋、退会・削除、難易度、定期処理を確認します。不変性、rollback、二重加算防止、対象・本人の分離も検証します。
通常APIで作った組織と実GameRoom DOを接続し、結果保存・本人履歴・順位・第三者への非公開を確認します。外部本人確認だけを隔離用の応答へ置き換え、実アカウントを退会させません。
`pnpm run check` は型・静的検査・全自動試験・設定検査・ビルドを行います。公開A/Bと実ブラウザーの受入は[検証項目](../development/testing.md)で区別します。

<a id="database-007"></a>
## 結果保存

結果・参加者の確定差分・配送原本を同じbatchで保存します。同じID・同じ内容の再試行だけを成功扱いにし、同じ試合IDの異なるhashはconflictにし、通常履歴と順位から除外します。失敗時はDOに原本と再試行予定を残します。
不変triggerは上書き・削除を拒否します。匿名化・期限処理・受付済み完全削除だけを制約で許可し、名前の消去でも確定レート・勝敗を変えません。通常APIからoutbox原本を公開しません。

<a id="database-008"></a>
## カタログ管理

問題登録・改訂・停止・セット作成・設定反映は、対象ownerと組織管理者を確認します。過去版を更新せず、改訂前の問題の停止と新しい版・有効参照を同じbatchで保存します。Webの作問・審査権限は管理CLIと別に確認します。
