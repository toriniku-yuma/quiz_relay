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

秘密の初回登録・変更は `wrangler secret bulk` を対象の設定・環境へ実施します。通常Workerと非公開Workerが同じD1 ID、DOのscript_name、service bindingを使うことを確認します。通常Workerの毎分Cronだけが非公開処理を呼びます。`pnpm run check` はclient assetsも生成します。デプロイ前にビルド出力のgzipサイズが利用プランの上限内に収まることを確認します。
外部ログインの同じタブの往復にはClerkの新しい外部戻り先を登録しません。Clerk認証の戻り先は所属元内の検証済み `/authorize-participation/` だけで、その後アプリが短命な署名証明を開催先へ返します。migrationを先に適用し、A/Bの秘密・originを維持してから、[変更画面の確認](../development/testing.md#federation-ui-changes)を行います。

保護された `/api/probes/game/status` は `gameReady: true`、検証インスタンス、メタデータ・問題取り込みの最終成功時刻とエラーを返します。本文・解答・認証秘密は返しません。初回の `/api/probes/game/setup` は対象名・管理者・インスタンスを照合し、未設定の問題・参加設定を登録します。カテゴリ共有・取り込み・個別除外は通常の管理画面で操作します。

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
3. `pnpm run federation:check:cloud` を実行します。通常health・Clerk公開設定・未認証拒否、保護された状態確認、メタデータの90秒以内・共有問題の7分以内の更新、A→B/B→Aの署名応答・nonce再送拒否・不正署名/宛先/期限拒否、25件以内の共有問題取得を確認します。
4. 終了コード0と `.wrangler/qa/federation-cloud-report.json` の `passed: true` を確認します。結果には検査名・時刻・所要時間、A/Bの同期成功時刻・共有同期のエラーコードを記録し、秘密・問題・ユーザー情報を残しません。失敗時は `failure`・`errorCode`・`synchronization` から調べます。直ちに連打せず、設定や同期エラーを解消してから再実行します。
5. [画面受入と実機確認](../development/testing.md#federation-manual)を行い、日時・Workerのversion・端末・操作・期待結果・実結果を記録します。Chromeで自動操作できる項目から進め、iOS Safariは実機で確認します。連携APIの検査だけで実認証・対戦画面・結果配送の受入を完了扱いにしません。

状態確認の最終成功時刻はCronを含む同期が最近成功した証拠です。Cron単独の継続稼働は、管理画面から手動同期を押さず2分以上あけて再検査し、最終成功時刻が進むことでも確認します。ソースのbinding検査だけではクラウドの実配置を証明できないため、デプロイの対象名・version・bindingを合わせて記録します。

障害試験は自動コマンドに含めません。検証用のA/Bについて、元の許可とrevisionを控え、片側の共有/参加許可を通常管理画面で解除し、新規利用拒否を確認してから元へ戻します。通信断は対象端末だけのオフライン操作で作り、既存Worker・DBを削除しません。サーバー停止時のoutbox再送は隔離テストで実施し、実クラウドでの滞留・再送時間は別に記録します。後片付けではテスト用の部屋・参加を通常画面で終了し、原本・履歴・DBを消さず、元の許可を照合します。

<a id="federation-load"></a>
### 少人数の実ログインと仮想利用者の負荷試験

実Googleアカウント2人で、所属元の本人確認、開催元への参加、再読込、試合終了、所属元の本人履歴を確認します。画面操作の試験と下記の仮想利用者試験を分け、仮想利用者の数をOAuthログイン数として数えません。

負荷試験には上記A/Bの秘密JSONと、対象アカウントへのWranglerログインが必要です。ローカルDBや本番設定を流用しません。インスタンスA-2/B-2と実行ごとのUUIDで隔離した本人確認fixtureを使い、その後の署名通信・チケット・Cookie・WebSocket・DO・D1は通常経路を通します。

```powershell
# アカウント全体のUTC当日の使用量を確認する。
node scripts/federation-usage.mjs
# 残枠が少ない日の疎通確認。2人ランク1試合の終了・再接続・履歴配送まで行う。
node scripts/federation-load.mjs 0.001 --ranked-only
# 先に短時間の疎通、次に継続試験。複数の負荷試験を同時に実行しない。
node scripts/federation-load.mjs 1
# 他の8人の切断をサーバーで確認してから部屋主を切断し、9人の復帰を検査する。
node scripts/federation-load.mjs 1 --disconnect-lobbies
node scripts/federation-load.mjs 30
# 所属元だけ未承認にし、本人履歴への配送も各試合で確認する。
node scripts/federation-load.mjs 30 --unapproved
```

切断原因を調べる試験では、負荷試験を開始する前に別のターミナルで `node scripts/federation-runtime.mjs 40` を実行します。A/Bの通常Workerと非公開サービスを同時に監視し、UTC時刻・CPU時間・結果・固定のエラー分類と保守タスク名を `.wrangler/qa/federation-runtime-開始時刻.json` に保存します。検証環境では `lifecycle` にDO識別子・初期化・待機接続・サーバーの切断理由・最終heartbeatからの時間も記録します。同じDOの初期化と切断を照合し、処理例外・heartbeat期限・実行環境の再起動を区別してください。毎分の `counts` に4サービスすべてが現れることに加え、`tails` の各対象が監視中で `errorCode` がないことを確認します。起動失敗・予定外の終了・ログバッファの上限超過は保存され、終了コード1と `complete: false` を返します。時間上限や本人の停止操作による終了は失敗にしません。`complete: true` でも採取時間や全WebSocketイベントの取得を保証するものではありません。途中終了や取得失敗があれば、その期間のサーバーログを採取できたとは扱いません。要求ヘッダー・本文・署名・認証情報・生の例外文は保存しません。

Cronの調査では、`events` の `scheduledTime` と成功・失敗・キャンセルを確認します。`maintenance` には既知の保守タスクの開始・終了時刻を記録します。最後に開始したタスクが終了しているか、次のCronで同期時刻が進むかを確認し、監視の取得完了とCronの成功を区別してください。

DOの詳細ログは、すべての接続・切断の採取を保証しません。対象の切断理由を取得できなかった場合は、サーバーの記録がないことを理由に原因を除外せず、クライアントの切断時刻と復帰結果を保持して未判定とします。

WebSocket要求の `canceled` は、試験で予定した再接続や試合終了時の切断でも記録されます。これだけで障害と判定せず、負荷試験の `transportEvents` と照合してください。[デプロイやCloudflare側の実行環境更新・配置変更でも接続は切れる](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/#shutdown-behavior)ため、継続試験中は対象Workerを更新せず、切断後の復帰も検査します。環境による再起動は、個々の切断原因をログで確認した場合だけ結論に使います。

[ログ監視の有効化にも実行環境更新が伴う](https://developers.cloudflare.com/durable-objects/platform/known-issues/#global-uniqueness)ため、監視を開始して2分程度あけてから利用者を接続し、試験中の監視の追加・再接続を避けます。この待ち時間はCloudflareの反映完了を保証する値ではありません。監視の終了は対戦・設定復元の後にします。WebSocket要求のログは切断後に届くので、要求開始時刻 `at` を切断時刻と扱わず、`receivedAt` と負荷試験の切断記録を照合します。

同時に4人ランク（A所属3人・B所属1人）と、8回答者＋専任者1人の非公開部屋を動かします。各試合で正常解答、同じ入力の再送、同じ試合への再接続、参加者全員の結果一致と保存確定を検査します。部屋は通常の「ロビーへ戻る」操作後に次の試合を開始し、専任者の解答拒否も検査します。試験中だけA-2のランク人数を4に変更し、終了処理で2へ戻します。Ctrl+Cでも開始済み試合の終了と設定復元を待ちます。強制終了した場合は復元成功を確認してください。

`--ranked-only` はA所属1人・B所属1人の2人ランクだけを実行します。部屋と `--disconnect-lobbies` は併用しません。指定時間を過ぎても開始済みの試合と本人履歴への配送を確認してから終了するため、`0.001` は60msで終了する指定ではありません。通常の4人・9人の継続試験や実Google認証の代替にはしません。

待機用WebSocketが切れた場合は、通常画面と同じ30秒の範囲で元の部屋・セッションへ接続し直します。準備操作中に切れて開始が「準備未完了」で拒否された場合も、接続を復元してから準備と開始をやり直します。予定した試合中の再接続と、待機接続の復旧数 `transportRecoveries` を別に記録します。`--disconnect-lobbies` では9本の計画切断を `plannedDisconnects` と `planned_lobby_disconnect` に記録し、予定外切断と区別します。他の8人の切断をサーバーで確認してから部屋主を切断し、既存の部屋主交代条件を維持します。この故障注入を9本の厳密な同時切断とは扱いません。`transportEvents` には切断・ソケットエラー・10秒を超えるクライアントのheartbeat間隔と、その時刻・部屋・進行状態を保存します。同時切断の時刻をサーバーのCPU超過・DOリセット・保守エラーと照合し、クライアント側の停止も区別します。復旧できない場合、別の部屋へ変わった場合、結果や履歴が一致しない場合は失敗です。接続が切れなかったことと、切断後に復旧したことを区別します。詳細なDOログは `PROBES_ENABLED=true` と `ROOM_LIFECYCLE_LOGS=true` の両方が必要で、公開A/Bの検証設定だけで有効にします。

仮想アカウントの登録は同時負荷を始める前に順番に行います。毎分D1・Workers・DOのアカウント全体の使用量を確認し、無料の日次枠の80%を超えた場合や取得できない場合は新しい試合を開始しません。コマンド数にも上限を設けます。集計には遅延があるため、80%での停止を無料枠超過の完全な保証とは扱いません。残枠が少ない日は実行時間を短縮します。有料プランへ自動変更しません。

使用量はUTC当日の合計です。D1・DOは時間単位のフィルターで取得し、集計軸を指定せず1件の合計だけを要求します。取得失敗は最大3回で打ち切り、認証期限前には既存のWranglerログインを通常の方法で更新します。期限直前のCLI実行で更新されなかった場合も、使用量APIの401を受けて認証を再取得します。CLIの出力や認証情報は報告へ含めません。[分析APIの制限](https://developers.cloudflare.com/analytics/graphql-api/limits/)により取得を拒否された場合も、計測なしで負荷試験を続けません。

`--unapproved` は開始前にB側の承認状態を退避し、所属元未承認の状態で参加と結果配送を確認します。各ランク対戦で結果IDがB側の本人履歴に届くまで3秒間隔で照合し、保存確定・履歴反映の時刻と所要時間も記録します。未反映の応答が90秒の待機期限を過ぎた場合は失敗です。期限直前の照合とHTTP応答待ちを含むため、成功時の実測時間が90秒をわずかに超える場合もあり、90秒以内の配送保証には使いません。終了時に元の承認状態へ比較更新で戻します。問題共有の許可は変更しないため、この実行中の問題・通常メタデータ同期の拒否は想定される挙動です。復元後は2分以上あけて公開A/Bの検査を再実行し、通常同期の自動復旧も確認します。復元直後の期限切れを復旧成功と読み替えません。

結果は `.wrangler/qa/federation-load-実行UUID.json` に保存します。終了コード0、各種別の試合数・再接続数・再送確認数、ACKのp50/p95/p99、エラー、使用量、人数設定の復元を確認します。30分を指定しても途中終了した報告は継続試験の合格にしません。[現時点の確認範囲](../development/testing.md#d1-clerk)を参照してください。

### 障害時の診断と片側未承認の検証

保護された `/api/probes/game/database-read` は固定QA環境のDB読み取り可否と所要時間だけを返します。`/api/probes/game/persistence` は自側のA-1/B-1を対象に、直近10部屋までの結果ID・保存状態・固定のエラー分類を返します。問題・解答・SQL・認証秘密は返しません。DB障害時も対戦結果の原本をDOに保持し、復旧後に同じ結果IDで保存を再試行します。CPU上限の障害では短周期の再試行を避けます。

`/api/probes/game/deliveries` に自側のQAインスタンスIDだけを送ると、直近20件の結果ID・終了時刻・配送試行数・次回予定・受領時刻・失敗コード・隔離状態を確認できます。結果本文・参加者・秘密は返しません。開催元での保存と、所属元への配送を分けて照合してください。結果を永続保存した直後、同じ結果の送信対象を最大2件まで非公開service経由で配送します。失敗や残件は毎分の定期処理で再送し、再接続・ゲーム進行の完了条件にはしません。定期処理でも保存済み結果の配送を先に実行し、他の同期失敗が起きても後続の処理を続けます。即時の試行だけで送達を完了扱いにせず、所属元の受領を照合します。

検証専用の `QA_PAUSE_MAINTENANCE=true` はA/Bの定期処理の切り分けにだけ使います。観測後は同じ設定でこの指定を外して再配置し、毎分Cronと結果配送の復旧を確認します。通常の受入・負荷試験は定期処理を動かした状態で行います。

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
