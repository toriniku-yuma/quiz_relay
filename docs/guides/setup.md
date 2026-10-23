# 開発環境・接続確認

[ドキュメント一覧](../README.md)

**通常アプリとローカル開発はD1、認証はClerkのGoogleログインを使用します。**

<a id="phase-0-002"></a>
## ローカルで動かす

Node 26.8.1 / pnpm 10.28.2を使います。

```powershell
pnpm install --frozen-lockfile
if (-not (Test-Path .dev.vars)) { Copy-Item .dev.vars.example .dev.vars }
pnpm db:migrate --local
pnpm dev
```

既存の `.dev.vars` を上書きせず、以下のClerkキーと初回管理者の `INITIAL_ADMIN_SUBJECT` を設定します。空のD1ではログイン後の組織設定画面で組織と初期インスタンスを作ります。データのあるD1へ初期seedを再投入しません。バックアップと復旧は[DB管理](database.md)を参照してください。
このPCはTailscale IP 100.102.202.80:5173と、設定済みHTTPS `https://desktop-149oae5.taildd84bf.ts.net:5173/` を使います。別PCのIP・証明書は後述の手順で合わせます。 `.wrangler` のD1・DO原本を再起動時に消しません。

<a id="phase-0-003"></a>
## 外部サービスの準備

Cloudflareアカウント、D1、Clerk Developmentアプリを用意します。同組織のインスタンスは同じWorker・D1・Authを共有します。別組織の検証はA/Bを別origin・別D1・別Clerkアプリに分けます。無料枠の空き容量を確認し、既存DBの削除や有料化で空きを作りません。
秘密キー・接続先の資格情報をチャット・スクリーンショット・Gitへ載せません。本番Clerkのドメイン・DNS・Google OAuth設定はDevelopmentの無料検証と別に準備します。

<a id="phase-0-004"></a>
## DB検証

[DB管理](database.md)のmigrationを適用し、開発ツールの「DBのcommit・rollback」でD1の同時保存とrollbackを確認します。 `pnpm db:check` は通常データと独立したD1で検証します。

<a id="phase-0-005"></a>
## 認証遷移の検証

Googleログイン、元画面への復帰、本人確認、ログアウトを確認します。ChromeとiOS Safari、通信失敗・古いコールバック・部屋招待からのログインも対象です。トークンとメールを表示・記録しません。退会の実アカウント確認は本人が行い、自動試験では隔離した本人確認・削除応答を使います。

<a id="clerk-free"></a>
## Clerkを無料で検証する

1. [Clerk Dashboard](https://dashboard.clerk.com/)でアカウントを作り、Hobbyプランのアプリ `quiz-relay-a-test` を作成します。Development環境を使います。有料機能・課金・Clerk Organizationsは有効にしません。Quiz Relayの組織・権限はD1で管理します。
2. SSO connectionsでGoogleを全ユーザー向けに有効にし、Sign-up & sign-in設定でメールコード・リンク・パスワード・電話・passkey等の別経路を無効にします。Google以外のproviderは追加しません。メール等を登録必須の追加入力にしません。DevelopmentのGoogleには共有OAuth資格情報を利用できます。[Google公式手順](https://clerk.com/docs/guides/configure/auth-strategies/social-connections/google)。
3. API keysの `pk_test_...` と `sk_test_...` を、Git管理外の `.dev.vars` のCLERK_PUBLISHABLE_KEY・CLERK_SECRET_KEYへ保存します。JWT公開鍵のPEMをCLERK_JWT_KEYに設定すると署名検証のための通信を省けます。鍵・トークンはチャットや結果欄に貼りません。
4. 初回管理者のClerk User IDを `.dev.vars` のINITIAL_ADMIN_SUBJECTへ設定します。
5. 専用消去Workerの `.env.erasure-local` にも同じClerkアプリのCLERK_PUBLISHABLE_KEY・CLERK_SECRET_KEY・必要ならCLERK_JWT_KEYを設定し、再起動します。構成が一致しない場合は起動を拒否します。[消去の運用](operations.md)。
6. ChromeでGoogleログイン・招待部屋への復帰・ログアウトを確認し、iOS Safariでも実施します。対戦のログアウトは開催元セッションの失効を先に行います。退会後のAuth削除・再登録と、権限を引き継がないことも確認します。

Developmentは1環境100ユーザーまでで、Productionとはユーザーを共有しません。本番データにはProductionのキーを使い、検証用Developmentへ本番データを接続しません。[環境の違い](https://clerk.com/docs/guides/development/managing-environments)。本番化には管理可能なドメイン・DNSと独自Google OAuth資格情報を準備します。[本番手順](https://clerk.com/docs/guides/development/deployment/production)。

組織間の公開検証では、別アプリ `quiz-relay-b-test` とB専用のWorker・D1を使い、A/BでAuthキー・署名鍵・originを混ぜません。現在Aには既存のDevelopmentアプリ `Quiz_relay` を使い、Bには `quiz-relay-b-test` を用意しています。各D1に1組織・2インスタンスを登録済みで、組織内のAuthを共通にします。隔離D1の検証は `tests/d1-*.test.ts` がmigrationを適用します。

<a id="federation-test"></a>
### A/Bの公開ゲーム検証環境

Cloudflare FreeとClerk HobbyのDevelopment環境で、通常ゲーム・管理画面・外部参加を公開しています。通常ゲームの設定は `config/federation/wrangler.game.jsonc`、非公開消去Workerは `config/federation/wrangler.erasure.jsonc` の `a`・`b` を使います。検証専用入口 `scripts/federation-game-worker.ts` が通常アプリを呼び、対象の検証組織だけの初期化を保護します。通常アプリの入口へ検証用認証や管理者代行を追加しません。

| 対象 | A | B |
| --- | --- | --- |
| 通常Worker・D1名 | `quiz-relay-federation-a-test` | `quiz-relay-federation-b-test` |
| 非公開消去Worker | `quiz-relay-federation-a-erasure-test` | `quiz-relay-federation-b-erasure-test` |
| 公開origin | `https://quiz-relay-federation-a-test.quiz-relay.workers.dev` | `https://quiz-relay-federation-b-test.quiz-relay.workers.dev` |
| Clerk Developmentアプリ | `Quiz_relay` | `quiz-relay-b-test` |

両D1へmigrationを適用済みです。各側に1組織・2インスタンス・対応する実Googleユーザーの管理者権限を登録しています。秘密はGit管理外の `.wrangler/federation-a-secrets.json`・`.wrangler/federation-b-secrets.json` へ保存します。CLERK_PUBLISHABLE_KEY・CLERK_SECRET_KEY・PROBE_TOKEN・SIGNING_PRIVATE_KEY（Ed25519 PKCS8）・PEER_PUBLIC_KEY（相手のSPKI）・TEST_ADMIN_SUBJECTをA/Bで分けます。非公開Workerには同じClerkキーと自側の署名鍵だけを設定し、公開route・workers.dev・preview URLを持たせません。

再配置は以下の順序です。Bも `--env b` とB用の秘密ファイルを指定します。ルートの通常クラウドDBへ検証設定を流用しません。

```powershell
pnpm run check
node node_modules/wrangler/bin/wrangler.js d1 migrations apply GAME_D1 --remote --config config/federation/wrangler.game.jsonc --env a
node node_modules/wrangler/bin/wrangler.js deploy --config config/federation/wrangler.erasure.jsonc --env a
node node_modules/wrangler/bin/wrangler.js deploy --config config/federation/wrangler.game.jsonc --env a
```

秘密の初回登録・変更は `wrangler secret bulk` を対象の設定・環境へ実施します。通常Workerと非公開Workerが同じD1 ID、DOのscript_name、service bindingを使うことを確認します。通常Workerはイベント時と毎時・日次Cronで非公開処理を呼び、非公開Workerは自己service bindingで続きを実行します。`pnpm run check` はclient assetsも生成します。デプロイ前にビルド出力のgzipサイズが利用プランの上限内に収まることを確認します。
外部ログインの同じタブの往復にはClerkの新しい外部戻り先を登録しません。Clerk認証の戻り先は所属元内の検証済み `/authorize-participation/` だけで、その後アプリが短命な署名証明を開催先へ返します。migrationを先に適用し、A/Bの秘密・originを維持してから、[変更画面の確認](../development/testing.md#federation-ui-changes)を行います。

保護された `/api/probes/game/status` は `gameReady: true`、検証インスタンス、メタデータ・問題取り込みの最終成功時刻とエラーを返します。本文・解答・認証秘密は返しません。初回の `/api/probes/game/setup` は対象名・管理者・インスタンスを照合し、未設定の問題・参加設定を登録します。新規の空環境では、`/api/probes/game/bootstrap`へ`confirmation: 新規検証環境`を送り、固定QA組織と2インスタンスを作成できます。既存組織には実行できません。`/api/probes/game/sharing`はA-1/B-1間の共有許可・取り込み作成・未完了取り込みの再開を検証します。通常の共有設定と個別除外は管理画面で操作します。

実Googleによる通常画面の本人確認、外部ランク・部屋対戦、所属元履歴・開催元の振り返り、共有問題の取り込み・検索・除外を確認しました。ブラウザー・実機・継続負荷の確認範囲は[検証状況](../development/testing.md#d1-clerk)へ集約します。

<a id="federation-cloud-check"></a>
### 公開A/Bで繰り返す連携検証

配置済みA/Bは以下のコマンドで検査できます。通常ゲーム用設定だけを読み、初期化・許可変更・対戦・退会を行いません。連携要求のnonceを少数保存し、通常の定期清掃に任せます。

| 設定項目 | 保存先・入手先 | 確認条件 |
| --- | --- | --- |
| A/Bのorigin、D1 ID、Cron、DO、消去service | `config/federation/wrangler.game.jsonc`・`wrangler.erasure.jsonc` | A/BのDBは別。自側の通常・非公開Workerは同じDB・DOを参照 |
| `CLERK_PUBLISHABLE_KEY`・`CLERK_SECRET_KEY` | 自側Clerk DashboardのAPI keys → `.wrangler/federation-a-secrets.json`／`federation-b-secrets.json` | A/Bで別Developmentアプリ。Googleだけを有効化し、メール・電話・パスワード・passkeyを無効化 |
| `SIGNING_PRIVATE_KEY`・`SIGNING_KID` | 自側Ed25519のPKCS8 PEMは秘密JSON、kidはgame設定 | 自側の署名鍵を使用。A/Bで別鍵 |
| `PEER_PUBLIC_KEY`・`PEER_KID` | 相手Ed25519のSPKI PEMは秘密JSON、kidはgame設定 | 相手の公開鍵・kidと一致し、通常管理画面でも相手を承認 |
| `PROBE_TOKEN` | 各秘密JSON | A/Bで異なる32文字以上の秘密値。チャットやブラウザーURLへ貼らない |
| `TEST_ADMIN_SUBJECT` | 自側ClerkのUser ID → 各秘密JSON | 検証組織「連携検証 A/B」の管理者で、プロフィール設定済み |
| 非公開Workerの秘密 | `.wrangler/federation-erasure-a-secrets.json`／`federation-erasure-b-secrets.json` | 自側Clerkキー・自側署名鍵のみ。管理者代行・probe秘密を不要にコピーしない |
| A-1/B-1の問題共有 | 通常管理画面 | 両側の送受信とカテゴリ共有が有効、少なくとも1件の承認済み問題と有効な取り込みあり |

秘密JSONは上表の環境変数名をキーに持つオブジェクトです。PEMの改行はJSONの `\n` として保存します。既存環境では登録済みなので再登録不要です。初回・変更時だけ、対象側に対応する秘密を登録します。

```powershell
$env:CLOUDFLARE_ACCOUNT_ID = 'cb60779f06e19f44410227423dd55e41'
$env:WRANGLER_LOG_PATH = Join-Path (Get-Location) '.wrangler/logs/federation-cloud.log'
# 初回・秘密変更時だけ。Bは両方の a を b に置き換える。
node node_modules/wrangler/bin/wrangler.js secret bulk .wrangler/federation-a-secrets.json --config config/federation/wrangler.game.jsonc --env a
node node_modules/wrangler/bin/wrangler.js secret bulk .wrangler/federation-erasure-a-secrets.json --config config/federation/wrangler.erasure.jsonc --env a
```

1. `pnpm run federation:check:cloud --config-only` でソース設定の整合を確認します。秘密・通信・DB変更は不要です。
2. 上記の配置手順で必要な変更だけを反映します。正常稼働中のDB・組織・共有設定を初期化しません。
3. `pnpm run federation:check:cloud` を実行します。通常health・Clerk公開設定・未認証拒否、保護された状態確認、メタデータの毎時更新と共有問題の日次更新、A→B/B→Aの署名応答・nonce再送拒否・不正署名/宛先/期限拒否、25件以内の共有問題取得を確認します。
4. 終了コード0と `.wrangler/qa/federation-cloud-report.json` の `passed: true` を確認します。結果には検査名・時刻・所要時間、A/Bの同期成功時刻・共有同期のエラーコードを記録し、秘密・問題・ユーザー情報を残しません。失敗時は `failure`・`errorCode`・`synchronization` から調べます。直ちに連打せず、設定や同期エラーを解消してから再実行します。
5. [画面受入と実機確認](../development/testing.md#federation-manual)を行い、日時・Workerのversion・端末・操作・期待結果・実結果を記録します。Chromeで自動操作できる項目から進め、iOS Safariは実機で確認します。連携APIの検査だけで実認証・対戦画面・結果配送の受入を完了扱いにしません。

状態確認の最終成功時刻はCronを含む同期が最近成功した証拠です。Cron単独の継続稼働は、管理画面から手動同期を押さず、対象の次回Cron（メタデータは毎時、共有問題は日本時間4時）を過ぎて再検査し、最終成功時刻が進むことでも確認します。ソースのbinding検査だけではクラウドの実配置を証明できないため、デプロイの対象名・version・bindingを合わせて記録します。

障害試験は自動コマンドに含めません。検証用のA/Bについて、元の許可とrevisionを控え、片側の共有/参加許可を通常管理画面で解除し、新規利用拒否を確認してから元へ戻します。通信断は対象端末だけのオフライン操作で作り、既存Worker・DBを削除しません。サーバー停止時のoutbox再送は隔離テストで実施し、実クラウドでの滞留・再送時間は別に記録します。後片付けではテスト用の部屋・参加を通常画面で終了し、原本・履歴・DBを消さず、元の許可を照合します。

<a id="federation-load"></a>
### 少人数の実ログインと仮想利用者の負荷試験

基本動作と切断・復旧は、先にローカルA/Bで検証します。短時間試験と30分継続が通った後に、公開A/Bで最終確認します。クラウドの利用枠が足りないことを理由にローカル検証も止める必要はありません。

```powershell
pnpm run check
node scripts/federation-local.mjs 0.001 --disconnect-host --disconnect-boundaries
node scripts/federation-local.mjs 30 --disconnect-host --disconnect-boundaries
```

ローカル試験は、既存のCloudflare開発エンジンMiniflareでA/Bの通常Workerと非公開サービスを起動します。実行ごとに新しいD1・DO領域と署名鍵を作り、既存DBとクラウドの秘密設定は読みません。通常のmigration・署名・本人認可・WebSocket・結果保存・配送処理を使います。A/Bの署名上のoriginは検証設定と同じですが、通信はローカルのWorkerへ閉じ、未知の送信先は拒否します。実際の外部接続やGoogleログインの検査ではありません。

ローカル・クラウドは同じ負荷スクリプトを使い、結果の `environment` で区別します。ローカルではクラウド使用量APIを呼びません。生成コードと接続設定は `.wrangler/qa/federation-local-UUID/`、D1・DOの状態はOS一時領域の `quiz-relay-federation-*` に隔離します。実際の保存先は起動ログの `local_ready.stateDirectory` で確認できます。SQLiteの同期書き込みがプロジェクトドライブのI/Oと競合するのを避けるため、状態の保存先を分離しています。終了時にWorkerを停止し、状態データは調査用に残して次回へ使い回しません。OSの一時領域整理で消えることがあるため、調査に必要な状態は別途保管してください。ローカルの応答時間をクラウドの性能保証には使いません。

実Googleアカウント2人で、所属元の本人確認、開催元への参加、再読込、試合終了、所属元の本人履歴を確認します。画面操作の試験と下記の仮想利用者試験を分け、仮想利用者の数をOAuthログイン数として数えません。

公開A/Bでの負荷試験には上記A/Bの秘密JSONと、対象アカウントへのWranglerログインが必要です。ローカルDBや本番設定を流用しません。インスタンスA-2/B-2と実行ごとのUUIDで隔離した本人確認fixtureを使い、その後の署名通信・チケット・Cookie・WebSocket・DO・D1は通常経路を通します。

外部参加者は初回にだけ外部ログインし、同じログインCookieで次の試合へ参加します。出力の `foreignLogin.logins` が1、`foreignLogin.joins` がランクの参加回数と一致することを確認します。

```powershell
# アカウント全体のUTC当日の使用量を確認する。
node scripts/federation-usage.mjs
# 残枠が少ない日の疎通確認。2人ランク1試合の終了・再接続・履歴配送まで行う。
node scripts/federation-load.mjs 0.001 --ranked-only
# 先に短時間の疎通、次に継続試験。複数の負荷試験を同時に実行しない。
node scripts/federation-load.mjs 1
# 他の8人の切断をサーバーで確認してから部屋主を切断し、9人の復帰を検査する。
node scripts/federation-load.mjs 1 --disconnect-lobbies
# 外部ログインの疎通に依存せず、9人部屋の強制切断・復帰を1試合確認する。
node scripts/federation-load.mjs 0.001 --rooms-only --disconnect-lobbies
# 部屋主だけの切断・交代後に、専任を選び直して9人で再開する。
node scripts/federation-load.mjs 0.001 --rooms-only --disconnect-host
# 開始待機・結果受信前の切断と部屋主交代を、短時間で先に検査する。
node scripts/federation-load.mjs 3 --disconnect-host --disconnect-boundaries
node scripts/federation-load.mjs 30
# 使用量に余裕があれば、同じ故障注入を含めて30分継続する。
node scripts/federation-load.mjs 30 --disconnect-host --disconnect-boundaries
# 所属元だけ未承認にし、本人履歴への配送も各試合で確認する。
node scripts/federation-load.mjs 30 --unapproved
```

切断原因を調べる試験では、負荷試験を開始する前に別のターミナルで `node scripts/federation-runtime.mjs 40` を実行します。A/Bの通常Workerと非公開サービスを同時に監視し、UTC時刻・CPU時間・結果・固定のエラー分類と保守タスク名を `.wrangler/qa/federation-runtime-開始時刻.json` に保存します。検証環境では `lifecycle` にDO識別子・試合／部屋ID・接続UUID・初期化・接続と切断・サーバーの切断理由・最終heartbeatからの時間も記録します。接続UUIDは負荷クライアントの記録と照合できます。`loggedAt` はログの発生時刻、`at` は呼出し開始時刻、`receivedAt` は監視で受け取った時刻です。同じDOの初期化と切断を照合し、処理例外・heartbeat期限・実行環境の再起動を区別してください。`tails` の各対象が監視中で `errorCode` がないことを確認します。起動失敗・予定外の終了・ログバッファの上限超過に加え、JSONの解析失敗は `TAIL_PARSE_FAILED`、終了時に残った未完成のJSONは `TAIL_INCOMPLETE_RECORD` として保存し、終了コード1と `complete: false` を返します。時間上限や本人の停止操作だけでは失敗にしませんが、未完成のログが残っている場合は収集不完全とします。`complete: true` でも採取時間や全WebSocketイベントの取得を保証するものではありません。途中終了や取得失敗があれば、その期間のサーバーログを採取できたとは扱いません。要求ヘッダー・本文・署名・認証情報・生の例外文は保存しません。

[Cloudflareの既知の制約](https://developers.cloudflare.com/durable-objects/platform/known-issues/#global-uniqueness)では、ログ監視の有効化もDOの置換要因になり得ます。Wranglerは内部で監視接続を作り直すため、子プロセスの終了監視だけでは切断を検出できません。監視スクリプトは再接続警告を`TAIL_CONNECTION_LOST`として記録し、その子プロセスを止めて`complete: false`にします。生の標準エラーは保存しません。試験中に追加・再接続した場合はその時刻も照合し、影響を除外できない試験を通常運用の障害頻度に混ぜません。配備履歴に更新がなくても、監視による更新・基盤側の更新・ネットワーク分断は除外できません。

負荷クライアントは正常終了の切断も `match_finished` として記録し、開始・終了の待機失敗では参加者ごとの接続ID、最終受信時刻、シーケンス、ソケット状態を保存します。ゲーム接続の切断や15秒の受信停止を検知すると、本人の結果APIを確認し、保存済みならD1原本で復元し、未保存なら同じ試合へ再接続します。未確認の入力は同じコマンドIDで再送します。再接続失敗は30秒の再試行窓で打ち切り、別試合への接続は直ちに失敗とします。復旧は全員の終了通知を待つ前に行います。この検査と、実ブラウザーでの通常クライアントの復旧検査は別です。

`--disconnect-boundaries` は初回の部屋の開始待機中に1人、ランク・部屋それぞれの初回試合の最終回答直前に1人のゲーム接続を切断します。後者は別の参加者が保存確定を受信するまで切断を保ち、終了通知を受け取れなかった参加者が本人の結果APIから復元できることを検査します。`planned_game_disconnect` の `boundary` と `game_reconnected`・`game_result_restored` を照合してください。次試合の継続も確認するため、短時間試験でも各種別を2試合以上完了したか確認します。

保存上限は `events` と `maintenance` が各1,000件、`lifecycle` が10,000件です。超過した件数は `dropped` の同名項目に記録し、終了コード1と `complete: false` を返します。上限超過後も件数集計と標準出力は継続します。保存済みの配列だけから全期間の発生頻度を計算しないでください。

Cronの調査では、`events` の `scheduledTime` と成功・失敗・キャンセルを確認します。 同じ失敗イベントの自動再試行を検証する場合は、元と同じ `scheduledTime` の再実行と、失敗対象の成功時刻更新・エラー解除を照合します。次の定刻実行や手動同期による回復と区別してください。`maintenance` には既知の保守タスクの開始・終了時刻、実行ID・処理番号・周期・結果を記録します。[結果の判定方法](operations.md)に従い、最後に開始したタスクが終了しているか、次のCronで同期時刻が進むかを確認し、監視の取得完了とCronの成功を区別してください。非公開サービスの503は、本文が `{"ready":false}` の場合だけ残件ありとして継続します。それ以外の503や本文の読取失敗はタスク失敗として記録し、後続タスクを実行した後にCron全体を未完了とします。

結果保存の失敗は `result_save_failed`、開始・取消の失敗は `match_lifecycle_failed`、終了通知の失敗は `match_finish_notification_failed` で記録します。監視の `events[].diagnostics` にある試合ID・DO識別子・エラー分類・発生位置を照合すると、再試行が成功した後も失敗を追跡できます。Alarmが例外を捕捉して正常終了していても、これらの失敗ログを保存します。

外部参加の503は `federation_peer_failed` で通信期限切れ・通信または転送の拒否・相手のHTTPエラーを区別します。監視の `diagnostics` に既知の通信先パス・制限時間・経過時間・相手のHTTP状態を保存し、参加・認可・予約の成功応答も所要時間を記録します。継続参加は所属元での認可準備、開催先での予約、所属元でのチケット発行を順に行い、認可要求内の予約通信はありません。各署名通信は5秒、ブラウザーの参加要求は20秒を上限とします。応答不明の参加は同じ操作IDで確認します。

DOの詳細ログは、すべての接続・切断の採取を保証しません。対象の切断理由を取得できなかった場合は、サーバーの記録がないことを理由に原因を除外せず、クライアントの切断時刻と復帰結果を保持して未判定とします。

通常ブラウザーはロビー・対戦の初回状態受信時に、既存WebSocketで接続診断を1回送ります。自動再接続で復旧した場合は、復旧までの最初の切断ID・検知時刻・検知の種類・切断コード・最後の状態受信からの経過時間・ブラウザーの通信状態と表示状態・再接続試行数・復旧時間も送ります。サーバーでは `socket_client_report` として保存し、利用者にコンソールの提出を依頼せず運営側で確認します。`source: client` は利用者側の申告であり、原因の確定や認可には使いません。診断の契約・制限は[通信プロトコル](../design/protocol.md#接続診断)を参照してください。

追跡時は、`socket_client_report.connectionId` を復旧後の接続ログ、`recovery.connectionId` を切断前の接続・切断・例外ログと照合します。初回の診断ログが見つからない場合は、同じ接続の`game_socket_closed`・`game_socket_disconnected`・`room_lobby_closed`にある`reportReceived`と`clientReport`も確認します。本文が両方のログにあっても、接続IDが同じなら1件として数えます。`receive_timeout` は状態受信停止、`connect_timeout` は接続開始後に有効な状態を受信できなかったことを示し、通信経路上の原因までは特定しません。復旧しないまま終了した場合、ページ再読込・手動再接続で接続処理を作り直した場合、診断送信自体が失敗した場合は、切断前の情報が届かないことがあります。受信した診断数とサーバーの接続数を比較し、欠測を成功扱いにしません。負荷クライアントは`connection_report_sent`・`connection_report_send_failed`で書込み成否も記録しますが、書込み成功はサーバー受信やログ保存の保証ではありません。コンソールの `client_socket_*` はローカル開発用としても残します。

負荷クライアントのHTTP通信失敗は`transportEvents`の`http_transport_failed`にパス・メソッド・経過時間・既知の接続エラーコードを記録します。APIから失敗応答を受けた場合は`api_failed`にHTTP状態・エラーコード・操作種別・参加者番号・操作IDと、取得できたCloudflare Ray IDを記録します。クエリー・Cookie・本文・生の例外を記録せず、HTTP失敗はそのまま試験の失敗として返します。WebSocketの初回接続も、既知の一時的な通信失敗だけを既存の30秒の復旧期限内で再試行し、`socket_connect_retry`と`socket_connect_recovered`を記録します。認証拒否・未知の例外・期限超過は失敗です。`ECONNRESET`等の通信エラーとHTTP 500を区別し、WebSocketの`socket_error`と`unexpected_close`が同じ接続なら1件の接続障害として数えます。同時刻の同一部屋の切断は、障害の件数と影響を受けた接続数を分けて報告します。

DOの例外は、更新による再起動を`DO_CODE_UPDATED`、置換を`DO_REPLACED`、保存処理のタイムアウトを`DO_STORAGE_TIMEOUT`、排他処理のタイムアウトを`DO_CONCURRENCY_TIMEOUT`、その他のリセットを`DO_RESET`として分類します。分類できない例外は既存の分類を維持し、原因を推測して埋めません。コード更新の通知だけでは、自分のデプロイ・監視開始・Cloudflare側の更新のどれが引き金かは断定しません。

負荷試験用の接続では、通常Workerの`load_socket_opened`に接続ID・部屋ID・ロビー／対戦の種別を記録します。監視はこのログをHTTPの異常終了記録へ付けるため、URLのクエリーが伏せられていてもクライアントの`transportEvents`と照合できます。接続時のログ自体が欠けた場合は、時刻の一致だけで同じ接続と断定しません。

切断失敗時は `events[].diagnostics` のDO識別子、処理段階、エラー分類と実行環境の `remote`・`retryable`・`overloaded` を照合します。WebSocketの元エラーと、切断時の読込・在席更新・保存・配信の失敗を区別します。`markers` は例外本文から固定の分類だけを抽出します。通常HTTPの500と切断失敗の診断では `errorType` と、ファイル名・行・列だけに絞った `locations` を最大6件保存し、`INTERNAL` でも配置バージョンと発生箇所を照合できます。例外本文・生のスタック・ディレクトリ・認証情報は保存しません。これらの項目がない過去の記録から、後で例外の詳細を復元することはできません。

外部参加の失敗は `federation_join_failed` の `operationId`・`stage`・`elapsedMs` と発生箇所を照合します。成功は `federation_join_completed` に記録します。同じ操作IDの再試行をまとめ、ログ行数と利用者の失敗回数を区別してください。保守処理の `maintenance_failed` は `task`・`instanceId`・発生箇所から失敗した処理と対象を絞ります。元の例外に発生箇所がなければ追加できず、これらのログだけでCloudflare内部や利用者回線の原因を断定することはできません。

通常Workerの本番向け設定と、検証用A/Bの通常Worker・非公開サービスの設定には、カスタムログを全件保存するWorkers Logs設定を用意しています。設定を配置した後は監視コマンドの常駐なしで検索できます。自動の呼出しログとトレースは無効にし、クエリー文字列を伏せます。Cloudflareの[保存期間](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)は無料プランで3日間なので、障害時は期限内に対象Worker・時刻・イベント・操作IDで検索し、配置バージョンと一緒に必要な記録を保存してください。ローカル監視の項目制限とは異なり、Workers Logsには既存のカスタムログも保存されます。`RESULT_CONFLICT` の候補原本には参加者・問題・回答統計などが含まれるため、診断記録の閲覧・共有先を管理してください。

再発率は、同じ配置バージョン・条件の成功と失敗を採取できた操作数を分母にします。欠測があれば観測できた範囲だけを報告し、同時切断した複数接続や保守失敗に続くCron失敗を独立した障害として重複集計しません。低頻度だけでは保留を決めず、再接続・結果保存・履歴配送・次回の同期が完了したか確認します。復旧期限の超過、結果の不一致、未配送の継続、同期時刻が進まない状態は再調査の対象です。

WebSocket要求の `canceled` は、試験で予定した再接続や試合終了時の切断でも記録されます。これだけで障害と判定せず、負荷試験の `transportEvents` と照合してください。[デプロイやCloudflare側の実行環境更新・配置変更でも接続は切れる](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/#shutdown-behavior)ため、継続試験中は対象Workerを更新せず、切断後の復帰も検査します。環境による再起動は、個々の切断原因をログで確認した場合だけ結論に使います。

[ログ監視の有効化にも実行環境更新が伴う](https://developers.cloudflare.com/durable-objects/platform/known-issues/#global-uniqueness)ため、監視を開始して5分以上あけてから利用者を接続し、試験中の監視の追加・再接続を避けます。重複した監視プロセスを残さないでください。この待ち時間はCloudflareの反映完了を保証する値ではありません。監視の終了は対戦・設定復元の後にします。WebSocket要求のログは切断後に届くので、要求開始時刻 `at` を切断時刻と扱わず、`receivedAt` と負荷試験の切断記録を照合します。監視自体の影響を切り分ける場合は、ライブtailを動かさない試験と分け、クライアント記録と取得可能な保存済みログで判定します。

同時に4人ランク（A所属3人・B所属1人）と、8回答者＋専任者1人の非公開部屋を動かします。各試合で正常解答、同じ入力の再送、同じ試合への再接続、参加者全員の結果一致と保存確定を検査します。全員の最終状態を本人のD1結果と照合し、所属元への配送も試合ID・終了理由・勝者・終了時刻・各人のcorrect・誤答・失格・棄権・専任の一致を検査します。部屋は通常の「ロビーへ戻る」操作後に次の試合を開始し、専任者の解答拒否も検査します。試験中だけA-2のランク人数を4に変更し、終了処理で2へ戻します。Ctrl+Cでも開始済み試合の終了と設定復元を待ちます。強制終了した場合は復元成功を確認してください。

`--ranked-only` はA所属1人・B所属1人の2人ランクだけを実行します。部屋と `--disconnect-lobbies` は併用しません。指定時間を過ぎても開始済みの試合と本人履歴への配送を確認してから終了するため、`0.001` は60msで終了する指定ではありません。通常の4人・9人の継続試験や実Google認証の代替にはしません。

待機用WebSocketが切れた場合は、次試合の準備時に30秒の範囲で元の部屋・セッションへ接続し直します。準備操作中に切れて開始が「準備未完了」で拒否された場合も、接続を復元してから準備と開始をやり直します。部屋主が交代した場合は現在の主を使い、出題専任が解除されていれば設定操作で選び直してから全員が準備します。自動継承をアプリに追加するものではなく、利用者の設定操作を試験で再現します。`--disconnect-host` は主だけを切断し、この交代後の再開を検査します。予定した試合中の再接続と、待機接続の復旧数 `transportRecoveries` を別に記録します。`--disconnect-lobbies` では9本の計画切断を `plannedDisconnects` と `planned_lobby_disconnect` に記録し、予定外切断と区別します。他の8人の切断をサーバーで確認してから部屋主を切断し、既存の部屋主交代条件を維持します。この故障注入を9本の厳密な同時切断とは扱いません。`transportEvents` には切断・ソケットエラー・10秒を超えるクライアントのheartbeat間隔と、その時刻・部屋・進行状態を保存します。同時切断の時刻をサーバーのCPU超過・DOリセット・保守エラーと照合し、クライアント側の停止も区別します。復旧できない場合、別の部屋へ変わった場合、結果や履歴が一致しない場合は失敗です。接続が切れなかったことと、切断後に復旧したことを区別します。接続・切断・接続例外・クライアント診断は本番でも記録します。初期化・処理時間など追加のDO検証ログには `PROBES_ENABLED=true` と `ROOM_LIFECYCLE_LOGS=true` の両方が必要です。

仮想アカウントの登録は同時負荷を始める前に順番に行います。開始時と5分間隔でD1・Workers・DOのアカウント全体の使用量を確認し、無料の日次枠の80%以上になった場合や取得できない場合は新しい試合を開始しません。コマンド数にも上限を設けます。集計には遅延があるため、80%での停止を無料枠超過の完全な保証とは扱いません。試験前に直近の消費速度と、次の取得までの5分に終了処理を加えた余裕を確認します。残枠が少ない日は実行時間を短縮します。有料プランへ自動変更しません。

使用量はUTC当日の合計です。D1・DOは時間単位のフィルターで取得し、集計軸を指定せず1件の合計だけを要求します。照会は`X-Rate-Limit-Type: account-based`を付け、対象アカウントの制限枠を使います。通常モードへの自動切替は行いません。[アカウント単位の制限](https://developers.cloudflare.com/analytics/graphql-api/account-based-rate-limiting/)では1つのaccountsブロックが1要求として数えられ、既定値は5分間に300要求です。正常時は開始時に1回、その後は前回の取得処理開始から5分以上空け、1分ごとの進捗処理で照会時刻を確認します。30分では最大7回が目安です。準備・終了処理が加わると増えるため、実際の回数は診断記録で確認します。公称上限以内でも照会枠の拒否を観測しているため、要求数だけで安定性を断定しません。

取得失敗は最大3回で打ち切りますが、照会制限は1回で打ち切り、新規試合を停止します。停止後の定期照会も行いません。

認証期限前には既存のWranglerログインを通常の方法で更新し、期限直前のCLI実行で更新されなかった場合も、使用量APIの401を受けて認証を再取得します。CLIの出力や認証情報は報告へ含めません。[分析APIの制限](https://developers.cloudflare.com/analytics/graphql-api/limits/)により取得を拒否された場合も、計測なしで負荷試験を続けません。使用量照会の`RATE_LIMIT`はゲーム用の日次無料枠不足と区別し、APIの応答から判別できる場合は`RATE_LIMIT_BUDGET`・`RATE_LIMIT_RESOURCES`・`RATE_LIMIT_QUERY_NODES`を記録します。

使用量取得は成功時・失敗時とも制限モード・HTTPの試行番号・開始終了時刻・ステータス・HTTP応答とGraphQLエラーのRay ID・数値のRetry-Afterと、既知の照会枠エラー判定を診断記録へ残します。応答本文・認証情報は保存しません。通常の監視では使用量だけを取得し、cost・budgetの追加取得は行いません。照会枠が尽きた場合は5分以上空けて取得を確認しますが、経過時間や1回の成功だけで回復と判断しません。低頻度でも再発する場合は診断記録で原因と照会間隔を確認し、既存の80%停止条件も満たす場合だけ再試験します。

`--unapproved` は開始前にB側の承認状態を退避し、所属元未承認の状態で参加と結果配送を確認します。各ランク対戦でB側の本人履歴へ届くまで3秒間隔で照合し、全員の成績と終了結果の一致を確認します。保存確定・履歴反映の時刻と所要時間も記録します。未反映の応答が90秒の待機期限を過ぎた場合は失敗です。期限直前の照合とHTTP応答待ちを含むため、成功時の実測時間が90秒をわずかに超える場合もあり、90秒以内の配送保証には使いません。終了時に元の承認状態へ比較更新で戻します。問題共有の許可は変更しないため、この実行中の問題・通常メタデータ同期の拒否は想定される挙動です。復元後は次の毎時Cronを待って公開A/Bの検査を再実行し、通常同期の自動復旧も確認します。復元直後の期限切れを復旧成功と読み替えません。

結果は `.wrangler/qa/federation-load-実行UUID.json` に保存します。終了コード0、各種別の試合数・再接続数・再送確認数、ACKのp50/p95/p99、エラー、使用量、人数設定の復元を確認します。30分を指定しても途中終了した報告は継続試験の合格にしません。[現時点の確認範囲](../development/testing.md#d1-clerk)を参照してください。

### 障害時の診断と片側未承認の検証

保護された `/api/probes/game/database-read` は固定QA環境のDB読み取り可否と所要時間だけを返します。`/api/probes/game/persistence` は自側のA-1/B-1を対象に、D1の直近10試合の試合ID・保存状態を返します。問題・解答・SQL・認証秘密は返しません。DB障害時も対戦結果の原本をDOに保持し、復旧後に同じmatchIdで保存を再試行します。CPU上限の障害では短周期の再試行を避けます。

`/api/probes/game/deliveries` に自側のQAインスタンスIDだけを送ると、直近20件のmatchId・終了時刻・配送試行数・次回予定・受領時刻・失敗コード・隔離状態を確認できます。任意の`matchId`を添えると過去の特定試合へ絞り込めます。結果本文・参加者・秘密は返しません。開催元での保存と、所属元への配送を分けて照合してください。結果を永続保存した直後、同じ結果の送信対象を最大2件まで非公開service経由で配送します。失敗や残件は毎時の再試行で再送し、再接続・ゲーム進行の完了条件にはしません。定期処理でも保存済み結果の配送を先に実行し、他の同期失敗が起きても後続の処理を続けます。即時の試行だけで送達を完了扱いにせず、所属元の受領を照合します。

検証専用の `QA_PAUSE_MAINTENANCE=true` はA/Bの定期処理の切り分けにだけ使います。観測後は同じ設定でこの指定を外して再配置し、毎時・日次Cronと結果配送の復旧を確認します。通常の受入・負荷試験は定期処理を動かした状態で行います。

片側未承認の試験では、Bの固定QA peerの3フラグだけを `/api/probes/game/peer-state` で比較更新できます。管理者・probe認証・固定の配置先を検査し、公開鍵・機能別許可を変更しません。先に空オブジェクトで現在値を取得し、その値を `expected`、未承認かつURL取得済みの状態を `next` として保存します。未承認の参加・本人履歴、明示禁止の新規参加拒否を確認した後、元の値へ比較更新で戻します。競合時は409で止め、他人の変更を上書きしません。稼働中の負荷試験とは同時に行いません。

### 組織間通信の検証環境を整える

通常APIを、まずローカルD1・隔離データで確認し、その後A/Bの公開HTTPS環境へ配置します。Cloudflareの既存アカウントでD1の使用数・残容量・Workers/DOの利用量を確認してから、無料枠にA/BのDBを作成します。空き枠を推測して既存DBを消したり、有料化したりしません。

初期の機能受入は各組織1試合4人と運営者各1人の計10人で行い、各組織の2インスタンスを順番に検証します。4インスタンスの同時試合は計16人で別に確認します。先にデータ量とClerk Backend APIの要求数を測定し、負荷試験の人数を増やします。認証確認は早押しの入力ごとには行わず、対戦中は開催元のDOセッションを使います。[ClerkのAPI制限](https://clerk.com/docs/guides/how-clerk-works/system-limits)も監視します。

公開A/Bでは、許可した相手origin、署名・nonce、接続解除後の結果配送、再送・二重受信・順序入替、タイムアウト・相手停止・復帰を確認します。障害は隔離した相手・ネットワーク設定で再現し、既存サービスの停止で作りません。ChromeとiOS Safariを同じテストアカウント構成で確認します。Safariでは画面遷移・バックグラウンド復帰・Wi-Fi/モバイル回線の切替も対象にします。

ログは要求ID・接続先・処理時間・D1のread/write行数・再試行回数を中心にし、トークン・署名秘密鍵・本文・メールを記録しません。難易度・同期・再送は上限と再開位置を持たせ、読み書き行数・CPU・保存量の実測で頻度を調整します。[連携の完了条件](../development/plan.md)に従い、実公開環境とSafari実機を未確認のまま完了扱いにしません。

<a id="phase-0-006"></a>
## クラウドでの実行

### 設定済みWorkersへのデプロイ

実行するのはユーザーの明示指示がある場合、または検証にサーバー実環境が必要な場合のみ。デザイン確認は原則 `pnpm dev` を使う。

[デプロイの判断基準](../development/rules.md)を参照。

Cloudflare認証と対象D1・Clerk秘密・消去サービスを確認します。新規環境ではD1 migration、非公開消去Worker、通常Workerの順に配置し、同じD1 IDとDO script_name・service名を設定します。

```powershell
# リポジトリのルートで実行する。
pnpm run build
pnpm exec wrangler deploy --var PROBES_ENABLED:true
```

公開受入には、配置済みのA/B設定を使います。

この検証Workerはユーザー指定でPROBES_ENABLED=trueを維持します。通常のpnpm deployはfalse既定なので、上記コマンドを使います。

Cloudflareのログインが切れている場合は、先に次を実行して対象アカウントへログインする。

```powershell
pnpm exec wrangler login
```

### 検証APIを使う場合

Googleログインの開始やDB・DOなどの検証を行う場合は、検証APIを有効にして配置する。

```powershell
pnpm run build
pnpm exec wrangler deploy --var PROBES_ENABLED:true
```

画面には.wrangler/.env.cloud-probeのPROBE_TOKENの値を入力する。ローカル用.dev.varsのトークンとは異なる。再読み込みや遷移で入力欄は消える。CLIでの確認は次を実行する。

```powershell
node --env-file=.wrangler/.env.cloud-probe scripts/probe.mjs
```

検証終了後も、このWorkerではPROBES_ENABLED=trueを維持します。

検証APIは常設の管理APIとして流用しない。別アカウントへ新規配置する場合は、この手順だけでは準備が完了しない。

対象アカウントのD1・DO・非公開service binding・Clerkの設定を準備します。

WebSocket検証経路 `/api/probes/socket` はAuthorizationヘッダーが必要なCLI/テスト用。

ブラウザーWebSocket APIは任意ヘッダーを設定できないため、この画面にWebSocket接続ボタンは設けていない。トークンをURLへ入れる回避策は使わない。

<a id="phase-0-010"></a>
## Tailscaleからの接続

Vite自身の自己署名HTTPSをTailscale経由で利用する構成です。証明書は30日有効で生成し、利用前に `openssl x509 -in .wrangler/tls/dev-cert.pem -noout -dates` で実際の期限を確認します。期限切れやIP・DNS名の変更時は再生成してください。

- 起動：`pnpm run dev`（Tailscaleへの接続が必要）
- 接続先：`https://desktop-149oae5.taildd84bf.ts.net:5173/`
- `.dev.vars`：PROBE_ORIGINを上記の末尾スラッシュなしのoriginへ設定。

  DEV_TLS_CERTとDEV_TLS_KEYには `.wrangler/tls/dev-cert.pem` と `.wrangler/tls/dev-key.pem` を指定する。どちらもGit管理外。
- 初回は自己署名の警告から「詳細設定」→対象サイトへ続行する。利用するブラウザーでsecure contextとWebCrypto/SHA-256の動作を確認する。
- Googleログインは検証するHTTPS URLから開始し、同じoriginへ戻る。Clerkの設定は[無料検証の手順](#clerk-free)に従う。
- ログイン検証にはTailscaleのDNS名を使用する。

  DNS名は同じ100.102.202.80へ解決する。

証明書はOpenSSLのreq -x509で生成し、SANに100.102.202.80、127.0.0.1、localhost、上記Tailscale DNS名を含める。期限切れやIP/DNS名変更時には再生成する。

Viteのserver.httpsへ証明書と鍵を渡し、外部のTLS終端サーバーは追加しない。

CLIで自己署名HTTPSを検証する場合は、コマンド用のPowerShellで `$env:NODE_EXTRA_CA_CERTS = (Resolve-Path .wrangler/tls/dev-cert.pem).Path` を設定してから `pnpm run probe` を実行する。

TLSの検証全体を無効にせず、設定した証明書をそのプロセスで信頼する。

以下のServe手順はHTTPSが必要になった場合の任意の代替手段として残す。

1. `.dev.vars` の `PROBE_ORIGIN` に自PCのTailscale HTTPS originを指定する（末尾スラッシュなし）。ViteのallowedHostsと検証APIの許可Originに使用する。

   転送ヘッダーは信頼せず、指定したOriginだけを追加で認める。
2. 代替のServe構成ではDEV_TLS_CERT / DEV_TLS_KEYを外し、`pnpm run dev --host 127.0.0.1` を起動する。

   待受は127.0.0.1:5173を維持し、ポート使用中なら別ポートへ自動変更せず停止する。
3. `tailscale serve --bg http://127.0.0.1:5173` を実行する。Serveが無効ならCLIが示す管理URLで有効化する。これはTailscale内向けServeで、Funnelではない。
4. `tailscale serve status` に表示されたHTTPS URLを開く。

   ClerkのDevelopmentアプリを設定し、上記のHTTPS originからGoogleログインを開始する。
5. GoogleログインはこのHTTPS URLから開始し、同じブラウザーの同じoriginへ戻る。localhostから開始したログインをTailscale側へ引き継がない。
6. 終了時は設定したHTTPS転送を `tailscale serve --https=443 off` で解除できる。既存の別サービスがある場合は対象を確認してから解除する。

`pnpm run probe` はPROBE_ORIGINのURLへ要求し、未設定なら開始しない。ローカルだけ検証したい場合は、そのコマンドに渡すPROBE_ORIGINを開発サーバーのorigin（例：`http://127.0.0.1:5173`）にする。

Cloudflare Vite pluginはローカルpreview用にWorker側のdistへ.dev.varsを生成することがある。distを公開ディレクトリとして丸ごと配らず、設定したclient assetsを使う。

開発サーバーから元の `.dev.vars` とdist側の `.dev.vars` を取得できないことを確認する。

<a id="phase-0-014"></a>
## 外部通信

通常アプリはD1 bindingへ接続し、DB接続文字列を使用しません。

連携先は検査済みの `https://worker.account.workers.dev` の完全一致です。URL参加の初回取得は公開鍵の固定GETだけを使用し、自動承認せず、既存鍵や明示禁止を上書きしません。固定path・`global_fetch_strictly_public`・redirect拒否・署名・永続nonceを併用し、未知の相手や任意URLへ送信しません。独自ドメイン・一般のDNS rebindingへの拡張は未対応です。

## ページと配置の現在の境界

`/` は `/game/` へ転送します。正式ランク参加は `/game/`、開発参加は `/local-game/`、検証は `/debug/` です。外部参加は `/participate/`、問題共有管理は `/question-sharing/` です。配色比較の `/design/` は廃止済みです。
現在のテーマと画面構成は[概要](../spec/overview.md)、整形は[開発ルール](../development/rules.md)を参照します。

本番buildはD1 bindingを使用します。A/Bには通常ゲームを配置済みです。
PC内DBの設定をクラウドへ流用せず、配置前に既存binding・Auth・DBとの差を確認します。
別アカウントでの初期構築・対戦保存・更新・復元を通した手順は未検証です。[構成と復旧](../design/architecture.md)。
