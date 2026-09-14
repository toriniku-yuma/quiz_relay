# 1C：正式ログインと自動マッチング

2026-09-14。正式ログイン画面、参加認可、自動マッチング、待機取消・定員、DB固定版による自動開始を実装。Supabaseへの適用、NodeとローカルWorkerからの実DB読込、4人接続での開始、認可・競合の自動検証を実施した。ユーザーからアカウント・自動マッチングに加え、案内したその他の手動動作も確認したとの報告を受領。方式別・操作別の詳細ログは取得しておらず、実測ログとユーザー報告を区別する。ユーザーの追加承認を受け、クラウド配置とゲームHibernation・対戦完走を検証済み。1Cは記載した受入範囲で完了。クラウドで本人のメール/Google操作を今回再実行したものではない。

## 引継ぎ時の確認

- HEADは `f157236`（1B）。作業開始時の `git status --short` は空。引継ぎ要約にあった未コミット変更は、現在のGitではコミット済みだった。
- 1Cの範囲はメール/Google認証、参加認可、待機・取消・定員、設定人数の接続完了による自動開始、DB固定版読込と開始前検証。未認証・二重参加・開始後の新規参加拒否と、公開環境の開発経路無効化を含む。
- 開始人数はユーザー回答により初期4人へ確定。config/matchmaking.jsonのplayersPerMatchで指定し、検証用・サーバー固有の値は別コンフィグで指定する。現行MVPの設定範囲は2〜4人。人数はDBの大会固定版へ保存し、待機中・開始済み試合へ設定変更を遡及しない。
- 既存DB接続は検証用 `quiz_probe`。Supabase操作はユーザーから一任され、登録済みPATによるManagement API経由で1Cスキーマとseedを適用済み。既存のDATABASE_URLを保ったまま、専用readerのGAME_DATABASE_URLを.dev.varsへ追加した。

## 実装順序と状態

1. **DB固定版**：migration、12問のseed、専用reader、hash・候補・ルール・停止状態の検証、裁定への固定を実装・実DB検証済み。
2. **正式認証・参加認可**：メール/GoogleのPKCEログイン、サーバー側getUserによる本人確認、actorと部屋に結び付くHttpOnlyセッションを実装。未認証・匿名・メール未確認・偽造actorを拒否。
3. **自動マッチング・画面統合**：開催元単位のMatchmaker DOで重複参加と枠を直列化。GameRoomで取消と接続完了を直列化し、開始直前にDBを再確認。通常の試合復帰はDO保存済み定義を使用。
4. **統合検証**：2・3・4人、同時10参加、取消競合、予約応答消失、ログアウトによる失効を自動検証。実DB＋ローカルDOで4人開始を確認。ブラウザーはログイン前画面、公開設定、未認証/実無効JWT拒否を確認。本人ログイン・複数アカウントE2Eは残件。

結果/outboxのDB保存、履歴、順位、最小管理、効果音は1D。連合チケットと外部所属参加は2A。

## DB固定版

非公開のquiz_gameスキーマとquiz_game_readerを使う。現在の定義はsrc/worker/db/schema.ts、適用はdrizzle/。旧supabase/migrationsは照合・Drizzle移行後に削除済み。

- ルール版、大会版、問題版、問題セット版と順序付き参照を保存する。ownerを複合主キー・FKに含め、版は更新/削除拒否triggerで保護する。問題改訂は新ID、問題のversionは1。
- 問題本文・正解・ダミー・解説・出典・許諾は `question_versions.payload` の非公開JSONへ保存する。論理設計のquestion_answersの分離は現時点では不要で、全体を同じ読取権限で保護する。
- `question_availability` は不変内容とは別の停止状態。停止済み・状態行欠落の問題は新規開始用の読込で拒否する。管理操作は1D。
- readerにはSELECTだけを付与。anon/authenticated/PUBLICにはスキーマ・テーブル権限を付与せず、全テーブルにRLSとreader用SELECT policyを設定する。
- ルールと順序付き問題内容をJCS正規化し、SHA-256の小文字hexで一致確認する。これはローカルDB用の表現で、連合署名プロトコルの確定ではない。
- 読込は1つのSQL statementで版・問題・停止状態を取得し、接続は必ず閉じる。失敗時に同梱モックへフォールバックしない。DB呼出しをbuzzや文字選択ごとに行わない。

検証の上限は1セット1〜100問、本文/解説各2000文字、正答32書記素、ダミー128個、選択肢2〜8個。表示間隔は1〜10000ms、文字解答/判定/全文待ちは1〜60000msの整数。正解数・失格回数は1〜100、復帰猶予は1〜60000ms。初期値7問・3回・30000msを維持し、JSONから大会ごとの固定版へ保存する。重複候補・不足候補・不正値・hash不一致を拒否する。

既存の1B保存データにはchoiceCountがないため裁定時に4を補う。旧DOの変換・削除は行わない。`createState`へ検証済み定義を渡すと、全問題・ルール・版参照を複製して固定する。正式参加はこのDB定義を使用する。開発用joinの新規作成もDBから問題を読み込む。既存DOの復帰は保存済み問題を使う。

## DB適用・接続・検証

現在のDB操作とmigrationはDrizzleへ統一した。[DB管理](database.md)の手順を使用する。既存DBは初期構造を照合し、Drizzleの適用済み履歴へ登録済み。旧SQLファイルは削除済みで、drizzle/だけを適用する。

- スキーマ変更：src/worker/db/schema.tsを編集し、`pnpm db:generate --name=変更名`、生成内容を確認して`pnpm db:migrate`。
- カスタムSQLが必要な機能：`pnpm db:generate:custom --name=変更名`。権限・トリガー等に限定する。
- 初期投入：空カタログだけで`pnpm db:seed config/matchmaking.json --apply`。既存環境には実行しない。
- 設定反映：`pnpm config:apply:local` / `pnpm config:apply:default`。
- 実DBの設定反映・権限確認：`pnpm db:check`。

CLI接続は.env.supabase-adminの専用writerとmigration管理者。アプリのreaderとTLS設定は維持。管理PATは通常処理で使わない。クラウドGAME_HYPERDRIVEの準備・配置は未実施で、既存PROBES_ENABLEDの維持指示は継続する。

## ローカル自動検証

`pnpm run check` を使用する。`tests/catalog.test.ts` は固定設定の裁定、旧試合への非遡及、候補不足、不正値、hash不一致、参照不整合、DB未設定、読込成功/欠落/停止/障害と接続解放を検証する。DB読込テストのSQL接続はモックであり、SQL構文・DB制約・RLSの実証ではない。

実DBのmigration/seed/権限/Node読込とWorker経路での読込・4人開始は検証済み。ブラウザーでの本人ログインから自動マッチング、ゲームのクラウドHibernationは未実施。詳細は[検証記録](verification-results.md)。

## コンフィグの変更と固定版

人数・ルール・問題セットをJSONで編集し、`pnpm config:apply:local` で反映する。版追加と有効プロファイル切替はCLIが行い、既存試合には遡及しない。手動のSQL作成・版番号指定は不要。[設定手順](configuration.md)を参照。seed生成は初期投入専用であり、通常の更新には使わない。

## 管理用接続と適用記録

ユーザーが.env.supabase-adminにPATを登録し、Supabase操作を一任済み。今回追加のユーザー操作は不要だった。ブラウザー操作ツールはrunner pipe-in接続エラーのため使用せず、[Management APIのSQL実行](https://supabase.com/docs/reference/api/v1-run-a-query)を使った。

- 事前照会でquiz_probeの存在と、quiz_game/quiz_game_readerの未作成を確認。
- `202609130001_game_catalog.sql`と4人用seedを個別のTXで適用。SQL Editor相当の直接SQL実行であり、Supabase CLIのmigration履歴へ登録したものではない。将来CLIへ移行する際は履歴を照合し、このSQLを再適用しない。
- quiz_game_readerだけにランダム資格情報を新規設定。SQLへ平文パスワードを含めずSCRAM verifierを渡した。既存ロールのパスワードは変更していない。
- 接続文字列は既存Supavisorの宛先・TLS設定を使い、ユーザーをreaderへ分離して.dev.varsのGAME_DATABASE_URLへ保存。既存DATABASE_URL、PROBE_TOKEN、Auth設定は保持。
- NodeからreaderでTLS接続し、demo版1・4人・12問とrulesHash/manifestHash一致を確認。SQLテストの一時行はrollback後0件。
- 管理PATはGit管理外の.env.supabase-adminに保持し、Workerの環境・フロントエンドへ渡さない。reader用GAME_DATABASE_URLもGit管理外。クラウドのGAME_HYPERDRIVE設定・Workersデプロイは未実施。

実行時のスクリプトは.wrangler/qaに分離し、秘密を表示しない。再検証用のSQLとreader用CLIはGit管理対象のsupabase/tests・scriptsに置く。詳細は[検証記録](verification-results.md)。


## 正式参加の操作

`pnpm dev` を起動し、https://desktop-149oae5.taildd84bf.ts.net:5173/game/ を開く。ルート `/` もここへ移動する。

1. メールまたはGoogleでログインする。メールの最新リンクは、送信した同じブラウザーで開く。登録済みのルートcallbackを維持し、code/hashを保持して/game/へ移動する。検証画面から開始した認証だけ/debug/へ戻す。
2. 表示名を入力し「マッチングする」を押す。大会と人数はWorkerがDBから取得し、利用者はルーム番号や人数を送らない。
3. 初期設定は4人。現在のローカル検証は2人版へ切替済みで、異なる2actorのWebSocket接続がそろうと開始する。開始前は取消可能。同一アカウントの複数タブは1人として扱う。
4. 誤って再読み込みした場合は自動復帰、必要なら「参加中の試合へ戻る」を使う。開始後の復帰猶予は1Bの30秒。試合中の取消は拒否し、ログアウトはそのactorの接続と部屋セッションを失効させる。
5. 終了後は次のマッチングへ進める。結果はDO内のみで、DB未保存・ランキング対象外。

旧仮UIは `/local-game/` へ分離した。開発時だけナビに表示し、公開ビルドでは参加APIを引き続き無効にする。旧ルーム/保存データを削除しない。正式DO名は `1c:<UUID>`、タブの復帰キーは `quiz-relay-1c:<Supabase user.id>` とし、別アカウントの復帰情報を使わない。

## 待機列と認可

- WorkerはSupabaseのgetUserでBearerを検証し、開催元とsubjectのJCS SHA-256からactorIdを求める。クライアント指定のactorId・人数・版は受け付けない。
- 参加/復帰APIはroomだけを返す。ランダムな部屋セッションはSecure・HttpOnly・SameSite=Strictのcookieへ設定し、DO内のactor対応表に保存。cookieのpathは/api/matchmaking、最大12時間。WebSocket URLへtokenを含めない。
- HTTP更新とWebSocketは同一Originを要求。開発時だけ設定済みPROBE_ORIGINも許可する。初回認証はSupabase、WebSocket再接続は有効期限内の部屋セッションで認可する。Authの外部管理画面からの失効が既存部屋cookieへ即時伝播する仕組みはない。
- actorごとの参加は開催元全体で1試合。予約を保存してからGameRoomへRPCし、途中停止でも同じroom/tokenで復帰する。開始済みの部屋へ新規actorは追加しない。
- 未接続の予約は60秒、接続後の待機中切断も検知後60秒で解放。待機部屋は作成から10分で失効し、全員不在でもAlarmで整理する。期限は参加/復帰で延長しない。
- 初期上限は開催元64ルーム、参加/復帰操作はactorあたり1分20回、レート記録1024actor。ゲームの同一actorは最大3接続。これは負荷性能の保証ではなく実装上の上限。
- 待機時に固定した大会版のhash・人数と、開始直前にDBで読み直した値を照合。問題停止や不正定義なら待機部屋を閉じる。一時的DB障害は開始せず再接続を待つ。進行中は問題DBへ依存しない。

## 実DBを使うローカルWorker試験

通常のcheckはDBアクセスをモックする。次は明示実行専用で、実SupabaseへSELECTだけを行い、隔離したテストDOで4人開始を確認する。Node起動時に.dev.varsのNODE_EXTRA_CA_CERTSを読み込む必要がある。

```powershell
$env:GAME_CATALOG_LIVE='1'
node --env-file=.dev.vars node_modules/vitest/vitest.mjs run
Remove-Item Env:GAME_CATALOG_LIVE
```

`tests/catalog.live.ts` が対象。DBにテストユーザーや問題を追加せず、実Authを通ったE2Eの代用にはしない。大会demo版1の4人と版2の2人、それぞれ12問を検証する。別環境では初期カタログと設定migrationを適用し、default/localを登録する。版番号が異なる場合はこの環境固有の固定版試験参照を合わせる。

Postgres.js 3.4.9のCloudflare接続終了時に、listener除去後のread失敗が未処理例外になる不具合を実DB試験で再現した。[upstream issue #1196](https://github.com/porsager/postgres/issues/1196)と一致し、patches/postgres@3.4.9.patchをpnpmに登録。終了後のlistener不在だけを扱い、実行中クエリのエラーを握りつぶさない。修正版への更新時はこのパッチを外し、上の試験を再実行する。

## クラウド検証前の受入・外部操作（解消状況は末尾）

追加のSupabase設定操作は現時点では不要。本人によるGoogle認証とメールリンク操作、および異なる2〜4アカウントでログインから対戦までの確認が残る。ローカルは検証用に2人設定へ切替済みのため、2アカウントで確認できる。同一subjectのタブ複製では代用しない。

管理キーで検証ユーザーを作る案は自動承認レビューにより、service-roleキー取得の明示許可がないため拒否された。キーは取得しておらず、この方式は採用しない。本人ログインによる通常経路で確認する。

クラウドはGAME_HYPERDRIVEの専用reader接続設定と配置を別途検証する必要がある。配置時は既存指示のPROBES_ENABLED=trueを維持する。今回クラウドの設定・Versionは変更していない。


## 2026-09-14：手動検証を2人へ切替

ユーザー指定により、supabase/seeds/demo-two-player.sqlを適用し、同じルール・12問を参照するdemo版2（2人）を追加。demo版1（4人）は保持。当初はローカル.dev.varsのGAME_DEFINITION_VERSION="2"で切り替えた。現在はGAME_CONFIG_PROFILE="local"とDBの有効プロファイルへ移行済み。標準4人・ローカル2人を維持し、公開環境は変更しない。

2人の別アカウントで/game/を開き、各自マッチングに参加すると開始する。以前の4人待機部屋へ復帰した場合は、一度「待機を取り消す」を押して新しく参加する。進行中の試合には遡及しない。4人へ戻す場合はconfig/matchmaking.local.jsonのplayersPerMatchを4へ変更し、上記のconfig:apply:localを実行する。


## 2026-09-14：レビュー2件の修正

開始前のDB読込をGameRoomの直列化区間の外へ移動し、待機中のheartbeat・取消・Alarmを処理できるようにした。DB返答後は保存状態を読み直し、セッション、期限、現在の人数、開始済みかを再確認する。開始の確定は引き続き直列化する。別接続がすでに開始した場合、遅れて届いたDBエラーで試合を閉じない。

正式画面の自動復帰でNO_ACTIVE_MATCHを受けた場合、古い部屋・snapshot・タブ保存情報を解放してマッチング画面へ戻る。一時的な通信/DB障害では情報を保持し、画面を離れた後の遅延応答では解放しない。

ユーザーはアカウントと自動マッチングの動作を確認済み。メール/Googleの各方式の個別結果、試合完走、クラウドの検証とは区別する。


## 2026-09-14：実行コードから問題のハードコードを撤去

src/worker/game/questions.tsの12問と出典・許諾データを削除し、supabase/seeds/mock-hiragana.jsonへ初期投入用データとして分離した。seed生成スクリプトだけがこのJSONを読み、テストはtests/fixtures/questions.tsから明示的に参照する。Worker/clientの実行コードはseed・テストfixtureをimportしない。既存DBへの再投入・変更は行わない。

createStateは外から渡された問題を必須とし、モックへ切り替える処理を廃止。正式参加は従来どおりDB固定版を使用する。/local-game/の新しい部屋もDBから問題を読み、検証用の人数・開始問題位置・文字共有設定を使う。開始問題位置はDBセットの範囲で確認し、部屋に位置を保存する。正式参加の開始直前再検証と異なり、旧開発経路は作成時の問題読込を対象とする。

保存済み旧DOは問題をすでに保持しているため、復帰時にはDBを要求せず、そのデータを使用する。旧部屋のmock-NN位置照合と、旧保存データでダミー候補が省略されている場合のひらがな候補生成は互換処理として残す。これらは問題本文・正解のフォールバックではない。

## 2026-09-14：設定のJSON化と有効プロファイル

202609140001_matchmaking_settings.sqlを実DBへ適用し、default→demo版1（4人）、local→demo版2（2人）を登録済み。既存版を再利用し、問題・既存試合は変更していない。新規参加はDBの有効参照を使い、待機中・開始済みは保存済み参照を使う。接続監視・待機期限・上限はconfig/runtime.jsonへ集約した。管理画面は未実装。詳細は[設定手順](configuration.md)。

## 2026-09-14：Drizzle移行

アプリ・設定反映・seed・probeをDrizzleへ統一。設定CLIのManagement API向け文字列SQL送信を撤去した。既存構造を照合して初期2件を適用済み登録し、専用writerとRLS明示の3件をDrizzleで適用。問題・既存大会・DOは保持し、現在のlocal=2人/default=4人を維持。CLIの管理接続は設定済みで追加のユーザー操作待ちはない。上記のManagement API・seed SQLの記録は移行前の実績。[DB管理](database.md)参照。

## 2026-09-14：再レビュー2件の修正

ルールの検証契約を標準JSONから独立させ、標準JSON自体の欠落・誤記を読込時に拒否する。MatchmakerのDB待ちを直列化区間の外へ移し、他actorの復帰・取消・Alarmを処理可能にした。DB返答後は最新の予約・定員を確認し、同一actorの古い返答は失効させる。DB失敗は503として返し、リクエスト回数は保持する。schema・migration・既存DB設定の変更は不要。

## 2026-09-14：手動受入の報告とクラウド検証着手

ユーザーが「他の動作も確認しました」と報告し、クラウド・Hibernation検証を依頼した。直前に案内したログイン方式別、2人の試合完走、待機取消・再接続・再マッチングを含む追加確認の報告として記録する。個々の操作の日時・ログをエージェントが取得したものではない。

最新コードの149テスト・型検査・Biome・ビルドが成功。既存配置のhealth・DO保存・Alarm・署名・probe用Hyperdrive DB接続も成功。ゲーム用DB接続はこれとは別。

ゲーム用Hyperdrive追加は自動承認レビューが実行前に拒否。ローカルのquiz_game_reader資格情報をCloudflareへ登録して接続リソースを新規作成することについて、明示承認が必要との理由。資格情報の送信、新規Hyperdrive作成、Worker再配置は行っていない。予定設定はquiz-relay-game-db、専用reader、既存Supavisor session port 5432、既存CAによるverify-full、キャッシュ無効、接続上限5。既存のprobe用接続・秘密・PROBES_ENABLED=true・既存DOデータを維持し、有料プランへ変更しない。承認後にGAME_HYPERDRIVEを追加して配置し、隔離した試合でゲーム復帰を検証する。

## 2026-09-14：クラウド配置・ゲームHibernation検証完了

ユーザーがゲーム読取専用資格情報のCloudflare登録と無料Hyperdrive追加を明示承認。quiz-relay-game-db（4e4a5dbafb8540a1aa13241013dc90c6）を作成し、既存CAのverify-full、キャッシュ無効、接続上限5で接続確認成功。vite.config.tsの本番ビルドにGAME_HYPERDRIVEを追加した。既存probe用接続は維持し、管理者・writer資格情報はWorkerへ登録していない。

149テスト・型検査・Biome・ビルド成功後、PROBES_ENABLED=trueを指定してquiz-relay-probeへ配置。Versionはb35b5779-c36a-4c92-8f66-cb15801c67fa。クラウドdefault=4人、ローカルlocal=2人を維持。設定ファイル・DB版・既存DOを削除・変換していない。

同じGameRoom/Matchmakerソースをimportする一時Workerの隔離DOで、11秒無通信後の同一WebSocket維持とinstance再生成、停止中のパネル・候補・猶予期限保持、再接続時の同一パネルと重複ACK、全員切断30秒後のAlarmによるINVALID、終端維持、待機取消を確認。観測用サブクラスはメモリ内instance IDと保存済み状態を読み取るだけで、ゲーム裁定・期限を変更していない。

通常配置のquiz-relay-probeのDOにも、一時Workerから隔離したMatchmaker名でRPCを行い、defaultのDB読込、4人接続で自動開始、7問正解による勝利、終了後再接続の結果保持、次のマッチングと取消を確認。一時Workerには新規専用ランダムトークンを使い、試験完了後にWorkerごと撤去。通常の公開参加APIに認証迂回を追加していない。既存検証トークンの一時Workerへの流用は自動承認レビューに拒否され、実行せず新規専用トークン方式へ変更した。

公開配置では画面・health・Auth設定の200、未認証の参加/設定APIの401、旧開発参加APIの404、既存probeのDB・DO・Alarmを確認。RPC試験は実メール/Googleログインとcookie受渡しのクラウドE2Eの代用ではない。本人による手動確認の報告と合わせて1Cを区切り、クラウドでの本人ログイン再確認は追加の環境別スモーク項目として区別する。結果DB保存・履歴・ランキング・管理・効果音は1D、連合は2A以降。
