# 退会・削除・保存期限の運用

[一覧](../README.md) ／ [運営仕様](../spec/organization.md) ／ [DB管理](database.md)

**アプリの利用停止と、認証・保存データの消去は別の処理です。専用Workerと定期実行を有効にしてから退会・完全削除を提供します。**
リポジトリには通常アプリの接続と専用Workerの毎分実行を設定済みです。コードを保存しただけでは定期処理は動きません。本番DBへの反映とWorkerの配置は、設置者が対象とバックアップを確認して行います。

## 専用Workerの設定

`wrangler.erasure.jsonc` は公開URL・公開ルートを持たないWorkerの設定です。通常のアプリにSupabase管理用キーやmigration接続を渡しません。

| 設定 | 用途 |
| --- | --- |
| `ERASURE_DATABASE_URL` | `quiz_erasure` の権限だけを継承する専用LOGINの接続。migrationロールを使用しない |
| `DATABASE_CA_CERT` | 接続先が必要とするDB証明書 |
| `SUPABASE_URL`・`SUPABASE_SECRET_KEY` | 対象Authのユーザー削除。専用Workerだけに設定する。既存環境の `SUPABASE_SERVICE_ROLE_KEY` も利用可能 |
| `GAME_ROOM`・`MATCHMAKER` | 対象アプリの既存DO。設定の `script_name` を設置先と照合する |
| `CLOUDFLARE_ACCOUNT_ID`・`GAME_ROOM_NAMESPACE_ID` | 既存部屋の全件照合先 |
| `DURABLE_OBJECTS_READ_TOKEN` | 上記アカウントのDO一覧を読めるトークン |

通常アプリからは `ACCOUNT_ERASURE` というservice bindingでこのWorkerを呼びます。`wrangler.jsonc` に接続を設定済みです。導入時はDBのmigration・専用権限・秘密・既存DOの接続先を確認し、専用Workerを先に配置してから通常アプリを配置します。Worker名を変更した設置先ではservice名とDOの `script_name` も合わせます。bindingの未設定時には、退会・完全削除を受け付けず「消去処理を利用できない」エラーにします。

専用Workerのscheduled handlerが認証削除の再試行、匿名化、完全削除の再試行、期限切れ記録の消去を行います。`wrangler.erasure.jsonc` は毎分実行のCron設定を含み、デプロイ時に有効になります。認証失敗は1分から最大1時間まで間隔を延ばします。定期実行の成功・失敗を監視してください。非公開の `/status` へPOSTすると、認証削除・匿名化・完全削除の未完了件数、30日期限超過、最古の未完了退会日時、未照合インスタンス件数を取得できます。本人ID・名前・メールは返しません。30日の個人情報削除期限に間に合わない障害は運営側で解消する必要があります。

各実行で部屋の処理件数を制限し、匿名化・完全削除・全件照合の進捗はDBへ保存します。正常応答でも未完了件数が残る場合は、次の定期実行またはCLI実行で続行します。完全削除は全室の安全確認が終わってから消去を開始します。進行中試合・未保存結果が見つかった場合は確認中の要求を取り消し、自動削除を予約しません。

認証削除だけを補助的に再試行するCLIは `node scripts/retry-account-erasure.ts` です。専用環境変数を安全な方法で渡します。このCLIだけではDO内の匿名化・完全削除は完了しません。

## ローカル開発環境

ローカルPostgreSQLの `127.0.0.1:55432/quiz_relay_dev` と、通常アプリが利用するAuthを対象にします。別DB・別Authへの誤接続は拒否します。

1. バックアップを取り、0047までのmigrationをローカルDBへ適用します。
2. 初回だけ `node scripts/operations-local.ts setup` を実行します。Authの管理用キーは環境変数 `SUPABASE_SECRET_KEY` で渡します。既存の `.env.supabase-admin` のManagementトークンから現在のプロジェクトのキーを読む場合は `setup --read-existing-key` を使います。Authのキーを作成・更新する操作は行いません。
3. 作成された `.env.erasure-local` はGit対象外の秘密ファイルとして保持します。ローカルDBに専用の `quiz_erasure` LOGINを設定し、migration接続をアプリへ渡しません。
4. `pnpm dev` を再起動します。Viteが通常アプリと専用Workerを接続します。専用キーは補助Workerだけに渡し、本番ビルドではこのファイルを読みません。
5. 既存インスタンスを下記の手順で休止し、`node scripts/operations-local.ts inventory` を実行します。ローカルのGameRoom保存ディレクトリを全件列挙し、実DOのownerと照合します。保存ディレクトリの欠落・不明なファイル・元DBのないWALは完了扱いにしません。
6. `node scripts/operations-local.ts status` で未照合が0になったことを確認して公開状態を戻します。再試行・期限処理は `node scripts/operations-local.ts maintenance` で実行できます。

ローカルの定期処理も、Workerを起動しただけでは実行されません。開発中の再試行は上記CLIで行います。これらのコマンドは本番DB・CloudflareのCron・デプロイを変更しません。Viteの監視から `.wrangler` のDB・バックアップ・DO保存データを除外しています。

## 既存部屋の照合

新規インスタンスは部屋の作成前にDOの実IDをDBへ登録します。既存インスタンスは、休眠中の部屋を含めた全件照合が終わるまで退会・完全削除を受け付けません。

1. 対象インスタンスを準備中またはアーカイブにし、書込みを止めてバックアップを取ります。
2. 専用Workerの `/inventory` を非公開の管理経路からPOSTで呼びます。Cloudflareの[DO一覧API](https://developers.cloudflare.com/api/resources/durable_objects/subresources/namespaces/subresources/objects/methods/list/)を最後のページまで走査し、部屋自身に保存されたownerと照合します。
3. `/inventory` は1回で最大100部屋を照合し、`ready: false` の間は再実行します。CLIは完了まで続けて呼び出します。失敗時も同じ処理を再実行すると保存済みのページから続行します。DBの `room_inventory_complete` を手でtrueにして省略しません。ローカルDOとクラウドDOの一覧は別物で、クラウドの照合結果をローカルへ流用しません。

既に起動済みの非公開管理Workerを直接利用する場合は、`MAINTENANCE_LOCAL_URL` に `http://127.0.0.1:ポート` を設定し、`node scripts/run-maintenance.ts inventory` または `node scripts/run-maintenance.ts maintenance` を使用できます。管理Workerを一般公開するためのルートは追加しません。

## 消去記録とバックアップ復元

退会記録と完了したインスタンス削除記録は、通常バックアップとは別に最新のものを保持します。古いバックアップだけを復元すると、それ以降の退会・削除を復元先が認識できないためです。

1. `PRIVACY_RECOVERY_DATABASE_URL` に管理専用接続を渡し、`node scripts/privacy-journal.ts export 保存先.json` で記録を出力します。既存ファイルは上書きしません。
2. 出力にはAuthのsubject等を含みます。Git・公開ストレージ・通常ログに置かず、アクセス制限した独立の保管先へ保存します。自動的な外部保管先への転送は実装していません。削除後の最新記録を失わない保管手順を設置時に用意します。
3. 復元時は一般アクセスと書込みを停止したまま、DB・DOを復元し、必要なmigrationを適用します。
4. 最新の独立記録を `node scripts/privacy-journal.ts restore 保存先.json --apply` で適用します。組織IDと本人IDのnamespaceが違う記録は拒否します。インスタンスは準備中になり、退会者の権限を外して消去を再予約します。
5. `/inventory` が `ready: true` になるまで、続いて `/maintenance` を未完了処理がなくなるまで実行します。削除完了記録に対応する復元済み部屋・DBを再消去します。退会者の認証・旧名の消去が済み、削除済みインスタンスが存在しないことを確認してから必要なインスタンスを公開します。

最新記録を確保できない場合や照合に失敗した場合は、復元したデータを公開しません。独立した削除記録の保管と復元後の照合は、バックアップ運用の必須条件です。

## 保持するデータ

保存期間は[仕様](../spec/organization.md#通知履歴の保存期間)を正とします。結果の問題振り返りを期限で消しても、勝敗・確定レート増減は変えません。部屋内の問題コピーは結果保存が確認できたものだけ消去し、未保存結果は再送できるよう保持します。
退会では本人IDを再利用せず、投稿問題と相手の結果を匿名化して保持します。完全削除では削除受付記録に一致するインスタンスだけを消し、共通アカウント・他インスタンスを残します。
