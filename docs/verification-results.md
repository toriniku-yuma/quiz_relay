# 検証記録

## 2026-09-08：0A・0Bローカル基盤

対象：基点commit `39e819c` に対する未コミットの0A・0B実装。Windows、Node 26.8.1、npm 11.19.0。依存はpackage-lock.jsonで固定。Vitest 4.1.11、Cloudflare Vitest plugin 1.1.5、Wrangler 4.129.1 / workerd 1.20260907.1、compatibility_date 2026-09-08、nodejs_compat。クラウドの地域・構成・RTT・負荷は未測定。

| 検証 | 結果・条件 |
| --- | --- |
| `npm run typecheck` | 成功 |
| `npm test` | Workers runtime内、2ファイル34件成功。検証コードのテストであり、ゲームのG/A/F/Dケース完了ではない |
| `npm run build` | UIとWorkerの本番ビルド成功、Tailwind生成CSSを含む |
| APIの公開境界 | health公開、検証API既定無効、未認証拒否、異なるOrigin拒否、未設定DB/Authの503を確認 |
| DO保存・競合 | 8件同時incrementで8増加。storageの値を確認 |
| Alarm | 期限前は再設定、期限後は処理して期限を消去、再実行で結果不変。実HTTPの5秒Alarmも確認 |
| WebSocket | Hibernation APIでacceptし、保存状態を取得。クラウドでの実休止・復帰は未検証 |
| ローカル再起動 | Vite/ローカルWorkersを停止・再起動し、count/deadline/firedAtが再起動前の保存値と完全一致 |
| Ed25519/JCS | Workers内round-trip、Node生成fixtureをWorkersで検証、実HTTPで取得したWorkers署名をNodeで検証 |
| 署名拒否 | 改ざん、異なる鍵/kid、期限境界、宛先/用途/版/method/path/hash不一致、重複nonce、上限超過、重複JSONキー、非有限数、孤立サロゲートを拒否 |
| 送信先検証 | HTTP・IP/loopback/link-local表記・未承認origin・任意path・3xxを拒否。実ネットワーク送信とDNS rebindingは未検証 |
| `npm run probe` | health/persistence/alarm/Workers→Node署名PASS、DBはNOT_CONFIGURED、AuthはMANUAL_CHECK_REQUIRED |
| ブラウザー | PlaywrightからEdgeを起動し、疎通・専用トークンでの設定状態・署名ボタンを操作。ページ例外なし。1100px幅の画面を目視、390px幅の横overflowなしを確認 |

試行中にWorkersではRequestのredirect:errorが非対応、WebSocketのclose code 1005が非対応と分かった。manual＋3xx拒否、正常close code 1000へ修正し、上記テストを再実施して成功した。

通常のコマンド実行とブラウザー接続ツールはrunner接続タイムアウトになったため、別のコマンド実行経路とPlaywright CLIを使用した。これはアプリの動作不具合とは分けて記録する。

## 未実施・次に必要なもの

- Cloudflare上のDO/Alarm/Hibernation復帰と実WebSocket維持。
- Supabase Transaction poolerへのTLS接続・commit/rollback・RLS/grants。専用migrationは作成済みだが未適用。
- メール・GoogleのPKCE遷移、redirect制限、ブラウザー間の参加チケット受け渡し。
- クラウド送信経路のDNS/SSRF検証と送信方式の確定。
- 永続nonce/jti消費、参加セッション、Q11〜Q14の契約確定、問題セットのサイズ・schema検証。
- Firefox/WebKit、実スマートフォン、負荷・性能・運用上限。

0Aは実環境DB・Auth・DO検証待ち。0Bは暗号/送信先のローカル検証までで、クラウド送信境界・Auth・契約の確定待ち。両方とも完了扱いにしない。準備・再実施の手順は[0A・0Bの実行手順](phase-0.md)を参照する。

## 2026-09-08：Supabase公開設定の接続確認

ユーザーがSUPABASE_URLとSUPABASE_PUBLISHABLE_KEYを設定した後、開発サーバーを再起動して確認した。値は記録しない。

- Workerの保護されたauth-config経路に設定が反映されていることを確認。
- 設定したpublishable keyでSupabase Authのsettingsを読み取り、HTTP 200を確認。
- メール認証は有効、Google認証は無効。新規登録は禁止されていない。
- npm run probeの疎通・DO保存・Alarm・Workers→Node署名は引き続き成功。
- DATABASE_URLは未設定。DB接続は未実施。
- メール送信・ユーザー作成・ログイン遷移は未実施。次にAuthのredirect設定とユーザー操作によるメールログインを確認する。

## 2026-09-08：Tailscale接続準備

- Tailscale接続済み、既存Serve設定なしを確認。Serve実行はtailnet側の有効化待ち。
- ローカル設定のPROBE_ORIGINからVite allowedHostsとWorkerの許可Originを設定。X-Forwardedヘッダーだけでは許可しないテストを追加。
- 実際の.dev.varsを自動テストの設定に流用しないよう、テスト用bindingsを明示。型検査・35テスト・本番ビルド成功。
- TailscaleのHost/Originを指定したローカルHTTPで、画面・health・保護されたstatusが200。元/生成済みの.dev.vars取得は403でトークン露出なし。
- クラウドVite pluginがWorker用distにpreview用.dev.varsを生成することを確認。client bundleへの配布とは区別する。
- 外出先端末からのHTTPSアクセスとTailscale URLでのAuth遷移は未確認。

ユーザー指定によりServeの有効化待ちを取り消し、Viteを100.102.202.80:5173で再起動。Tailscale IP直接指定のHTTPで疎通・保存・Alarm・署名検証が成功。外出先端末からの接続とAuth遷移は未確認。

## 2026-09-08：Tailscale HTTPでの認証失敗の切り分け

ユーザーからPKCE WebCrypto警告とCORS失敗の報告。メールを送信せずAuth OTPのOPTIONSを同一ヘッダーで比較した結果、Tailscale IPのHTTP Originは403・Allow-Originなし、localhostとTailscale HTTPS Originは200・Allow-Originあり。HTTPS化後の実ログインはまだ未確認。

HTTPの非secure contextではログインを開始しない画面表示とガードを追加。型検査・ビルド成功。EdgeでHTTP接続時にメール/Googleボタンが無効、理由表示ありを確認。画面接続とAuth動作を分けずにHTTPでのログインを案内した点を修正する。

## 2026-09-08：Viteの自己署名HTTPS

ユーザー指定によりOpenSSLで30日有効の証明書と秘密鍵を.wrangler/tlsへ生成し、Vite自身のTLSを有効化。CAのシステム登録やServeは行っていない。

- HTTPS IPのOTP preflightは403・Allow-Originなし。HTTPS Tailscale DNS名（ポート5173）は200・Allow-Originあり。同じIPへ解決されるDNS名をログイン用URLとして採用。
- Edgeの初回証明書警告を実際に詳細設定→続行して表示。ignoreHTTPSErrorsや証明書検証無効化フラグは使用していない。isSecureContext=true、WebCryptoのSHA-256が32バイト、health=200、メール入力後のログインボタン有効を確認。
- NodeはNODE_EXTRA_CA_CERTSに今回の証明書を指定。HTTPSの疎通・DO保存・Alarm・Workers→Node署名検証成功。
- 秘密鍵と.dev.varsのHTTP取得は403。証明書・鍵はGit管理外。
- 型検査、35テスト、本番ビルド成功。
- Supabase側の新しいRedirect URL登録、外出先端末での警告続行、実メールログインはユーザー操作待ち。メールはこの検証で送信していない。

## 2026-09-08：認証結果の自動表示

メールから戻っても実行結果が「未実行」のままになる表示上の不備を修正。Auth SDKのinitialize完了後にgetUserで本人確認し、結果を自動表示する。既存ログイン状態のある再読込でも確認する。別タブなど開始時の情報がない場合とリンク交換失敗は説明を表示し、処理後のURLから認証code/errorを除く。

型検査・本番ビルド成功。EdgeでSupabase通信をテスト応答に差し替え、コード交換→本人確認成功、交換拒否、開始情報なしの3ケース成功。証明書はUI回帰テストのブラウザーcontextに限ってignoreHTTPSErrorsを使用。実メール送信や実ユーザーのログイン成功は未確認。

## 2026-09-08：認証の回数制限表示

Supabase AuthのエラーについてHTTP statusとcodeを表示し、429は回数制限として案内する。送信成功時も連続再送を避ける説明を追加した。型検査・本番ビルド成功。EdgeでOTP応答を429に差し替え、制限メッセージ・status/codeの表示とリクエストが1回のみであることを確認した（.wrangler/check-auth-rate-limit.mjs、Git管理外、証明書検証の省略はテストcontextのみ）。実メールは送信していない。実環境の制限解除とログイン成功は未確認。
## 2026-09-08：メール認証の別タブ対応

開始情報を失う原因の一つだったsessionStorageのタブ制限を解消し、公開Auth設定とSDKの保存先をlocalStorageへ変更した。同一ブラウザー・同一originの別タブでPKCE verifierと認証状態を共有する。別端末・別ブラウザーへの引き継ぎは対象外。認証状態はブラウザー終了後も残るためログアウトを案内した。

型検査・本番ビルド成功。Edgeの2タブでSDKによるPKCE challenge生成→別タブでのverifier一致→getUser成功を確認。ログアウトで保存セッション削除、別ブラウザーcontextで開始情報なしの表示も確認（.wrangler/auth-cross-tab-check.mjs、Git管理外）。Auth通信は全てテスト応答、自己署名の検証省略はテストcontextのみ。実メールのログイン成功はユーザー確認待ち。ユーザー報告によりGmail SMTP設定済み、実送信成功は未確認。
## 2026-09-08：実メールログイン成功（ユーザー確認）

Gmailの独自SMTP設定と別タブ対応の修正後、ユーザーが実メールリンクを開き、検証画面で authenticated: true と本人確認成功の表示を確認した。Supabase AuthのgetUserによる実ユーザーの本人確認まで成功。上記の実メールログイン未確認という残件は、この報告により解消した。Google OAuth、実環境のログアウト・再ログイン、DB接続、クラウド配置などの残件は引き続き未完了であり、0A・0B全体の完了とは扱わない。
## 2026-09-08：実環境のログアウト・再ログイン成功（ユーザー確認）

ユーザーがログアウト後の本人確認で authenticated: false、新しい実メールによる再ログインで本人確認成功まで確認した。メール送信→リンクからログイン→getUserによる本人確認→ログアウト→未認証確認→再ログインの一連の検証は完了。直前の記録にある実環境のログアウト・再ログイン未確認の残件は解消した。Google OAuth、DB接続、クラウド配置などは引き続き別の残件とする。

## 2026-09-09：npm run devのTailscale起動

ユーザー指定によりdevスクリプトをvite --host 100.102.202.80 --port 5173へ変更。npm run devで自己署名HTTPSサーバーが起動し、証明書を指定したcurlでTailscale DNS名の/api/healthが成功することを確認した。起動手順も更新。

## 2026-09-09：pnpmへの移行

ユーザー指定によりインストール済みpnpm 10.28.2へ統一し、packageManagerに固定した。pnpm importで既存package-lock.jsonからpnpm-lock.yamlを生成し、旧lockfileは削除。直接依存の指定バージョンは維持した。esbuildとworkerdのpostinstallのみ許可し、node_modulesを削除後、pnpm install --frozen-lockfileが成功。pnpm run checkで型検査、35テスト、本番ビルドが成功した。pnpm devの起動とTailscale DNS名へのHTTPS /api/health応答も確認。実行手順を更新し、過去のnpm実行記録は当時の実績として残した。
## 2026-09-09：DB検証用migration適用（ユーザー報告）

ユーザーがSupabase SQL Editorで202609080001_probe.sqlを実行し、成功を報告した。quiz_probe接続用パスワードの設定と実DB接続・権限制御の検証は次の作業。psql未導入のため、一時管理者設定をGit管理外の.env.db-adminへ分離し、既存のPostgres.jsで設定する準備をした。Workerへこの管理者設定は渡さない。接続情報入力後、検証ロールのパスワード設定とDATABASE_URLへの反映を行い、一時ファイルを削除する予定。まだ管理者接続・パスワード設定は実行していない。
## 2026-09-09：実Supabase DB接続成功

ユーザー取得のprod-ca-2021.crtをsupabase-ca.crtとして使用。Node側はCA指定と証明書/hostname検証を有効にして管理者接続が成功。quiz_probeにsuperuser/createdb/createrole/bypassrlsがなく、runsでRLS有効を確認。専用パスワードを乱数生成し、SCRAM verifierで設定した。専用ロールとしてcommit/rollback、anon/authenticatedのschema/table権限なし、quiz_probeのschema CREATE権限なし、実DDLの42501拒否を確認した。

ローカルWorkerは初回Network connection lostで失敗。Postgres.jsのworkerd実装ではcaオプションがTLSへ渡らないため、Miniflareが起動時に読むNODE_EXTRA_CA_CERTSを設定した。pnpm devを.dev.vars読込付きへ変更・再起動後、pnpm run probeがhealth/persistence/alarm/Workers→Node署名/databaseすべてPASS。検証後のrunsは0行。一時診断APIとドライバーaliasは撤去し、一般エラー応答を維持した。型検査・35テスト・ビルドも成功。管理者設定.env.db-adminは作業完了後に削除した。

これはローカルWorker→実Supabaseの結果であり、Cloudflare配置後の接続・CA互換性は未検証。Googleログインは設定完了の報告を受けたが、実ログイン成功の確認はメール認証とは区別する。
## 2026-09-09：Cloudflare初回配置

OAuthログイン後、既存Workerがないことを確認。ビルドとdry-runに成功し、quiz-relay-probeをPROBES_ENABLED=falseで初回配置した。Wranglerがworkers.devサブドメインを登録し、https://quiz-relay-probe.quiz-relay.workers.dev を返した。Version ID: 61e80dc8-1917-4f40-852f-24f6bf277f36。直後の公開URLへのfetchは接続失敗であり、疎通は未確認。

DB接続URL・CA・Supabase設定とクラウド専用検証トークンをSecret登録する操作は、具体的な秘密情報の外部転送への明示的承認がないとして自動承認レビューに拒否された。登録操作は実行されていない。ユーザー承認後にSecret登録、検証APIの一時有効化、DB/DO/Alarm/WebSocketの実環境検証を行う。検証後はAPIを再び無効化する。
## 2026-09-09：Cloudflare Secret登録・無料条件の確認待ち

ユーザーが検証用Secret登録を承認（費用がかからないことが条件）。クラウド専用トークン、検証ロールのDATABASE_URL、DATABASE_CA_CERT、SUPABASE_URL、SUPABASE_PUBLISHABLE_KEYをSecret登録した。登録用の一時JSONは削除済み。クラウドの専用トークンとoriginはGit管理外の.wrangler/.env.cloud-probeに保存。公開/api/healthは200。検証APIは無効のまま。

契約プラン確認のsubscriptions APIはOAuth権限不足で403。workers/standardのstandard:trueは無料プラン確認の証拠として扱わず、ユーザーへWorkers Freeの表示確認を依頼した。有料プランへの変更や有料サービス追加は行っていない。

WebSocketのDO再生成判定用instanceIdを実装し、接続時刻attachmentとの比較スクリプトを準備。型検査・35テスト・ビルド成功。今回のinstanceId変更のクラウド配置と実検証は無料条件確認後に行う。
## 2026-09-09：Workers Free実環境検証

ユーザーがWorkers Freeを確認。検証APIを一時有効化し、実HTTPでhealth、DO保存、Alarm、Workers署名のNode検証まで成功。DBプローブはHTTP 500で失敗し、全項目PASSではない。WebSocketは30秒無通信の前後で接続を維持し、countとconnectedAt attachmentが一致、instanceIdが変化した。DO再生成後の状態・attachment復元を確認した。

DBの代替としてHyperdrive Free（1日100,000クエリ、上限超過時はエラー）でSupabase CAを用いたverify-full接続を準備。CA登録成功、ID 8510a1fc-296c-40fc-9cc9-4d5e264fdc6b。設定案はquiz-relay-probe-db、検証専用ロール、Supavisor session port 5432、キャッシュ無効、接続上限5。Hyperdriveの作成と資格情報登録は自動承認レビューに拒否され、未実行。既存WorkerのSecret登録とは別の明示承認待ち。

検証APIをPROBES_ENABLED=falseへ戻し、認証トークン付きstatusが404であることを確認。最終Version ID 549348cc-5d89-4d74-8d39-cd796a8827bf。有料プラン変更なし。クラウドDB接続、クラウドURLでのAuth、DNS/SSRFと連合契約の残件は未完了。
## 2026-09-09：Hyperdrive Free経由のクラウドDB成功

ユーザーが無料Hyperdrive作成と検証DB資格情報登録を明示承認。quiz-relay-probe-db（ID 49ed9c4348e1429d8f04cc6a47755e21）を作成し、Supavisor session port 5432、quiz_probeロール、CA ID 8510a1fc-296c-40fc-9cc9-4d5e264fdc6b、sslmode verify-full、キャッシュ無効、origin_connection_limit 5を設定。作成時の接続確認成功。

Viteの本番ビルドだけにHYPERDRIVE bindingを追加し、ローカルは既存DATABASE_URL経路を維持。Hyperdriveの内部接続ではドライバー側TLSを開始せず、Hyperdrive→DBのverify-fullを設定で担保する。API結果はhyperdrive-managedと表示する。型検査・35テスト・ビルド成功。

Cloudflare上でpnpm相当のscripts/probe.mjsを実行し、health、DO保存、Alarm、Workers署名のNode検証、DB commit/rollbackすべてPASS。未認証401・異なるOrigin403、公開URLから秘密値が返らないことも確認した。WebSocketの休止復帰は直前のクラウド検証で成功済み。検証後のDB行は0行、検証ロールでDDL拒否を再確認。

Workerに重複していたDATABASE_URL/DATABASE_CA_CERT secretsは削除し、DB資格情報をHyperdrive設定へ集約。PROBES_ENABLED=falseへ戻し、トークン付きstatusの404を確認。最終Version ID cd64eb1c-b5a7-41c1-8b49-6e5e89acb7c4。Workers Freeのまま、有料プラン変更なし。クラウドURLでのAuthとDNS/SSRF・連合契約は未完了であり0A・0B全体完了とはしない。
## 2026-09-10：クラウドGoogleログイン成功（ユーザー確認）

ユーザーがローカルのGoogleログイン成功を報告。続いてWorkers URLをSupabaseのRedirect URLsとGoogle OAuthクライアントのJavaScript生成元に追加したと報告した。検証APIを一時有効化し、statusとauth-configのHTTP 200を確認。クラウド専用PROBE_TOKENでの操作を案内した後、ユーザーがクラウドでのGoogleログイン成功を報告した。クラウドでのメール認証・ログアウト・再ログインは今回の確認範囲に含めない。

確認後はPROBES_ENABLED=falseへ戻し、トークン付きstatusが404 / PROBES_DISABLEDであることを確認。Version ID: fcd24451-e610-4097-bf83-62971397f5f0。コード変更やテスト再実行はなし。DNS/SSRFの実環境検証と連合契約の残件は維持する。
## 2026-09-10：0A・0Bの完了判定と限定egress検証

文書と実績を照合。0Aは開発・ビルド、ローカルDB、クラウドHyperdrive/DB、DO保存・Alarm・WebSocket再生成復帰、メールとGoogleのAuth結果がそろい完了と判定した。Authのユーザー報告範囲は前項を維持し、Googleログアウト等の追加実測を捏造しない。

旧0B計画には詳細契約確定も含まれていた。今回の範囲整理でチケットは2A、大会・共有は2B、本番配送は2C、取消・訂正は3Aの着手前へ移動。旧条件の全件成功ではなく、限定技術基盤としての完了判定である。

DNS変更可能なドメインをユーザーは持っていないため購入せず、peerRequestを承認したworker.account.workers.devのHTTPS完全一致へ制限。独自ドメイン、紛らわしいsuffix、別ポート、余分なラベルを拒否する39テスト・型検査・ビルドが成功。URL拒否と3xx拒否はWorkersローカルテストで確認しており、実DNS切り替えや実3xxサーバーは今回試験していない。

クラウドの固定自Worker宛POSTは初回500。公式仕様に基づきglobal_fetch_strictly_publicを追加すると成功した（初回の詳細例外は取得していない）。未実装inboxのJSON 404を確認する疎通であり、配送機能は未実装。送信本文は公開のダミー文字列、宛先はコード内固定で、入力URL・Authorization・cookieを転送しない。scripts/probe-egress.mjsで疎通・未認証401・異なるOrigin403がPASS。DNS rebindingはNOT_TESTEDと明示。

変更後のクラウドhealth・DO保存・Alarm・Workers→Node署名・DB commit/rollbackもPASS。有効時Version ID 828b30b0-a686-43db-9f83-811e210e17a1。終了後はAPI無効へ戻し、トークン付きstatusとegressの404 / PROBES_DISABLEDを確認。最終Version ID cea32f2b-9db3-455f-a86b-5e5841f9f4fb。有料リソース追加なし。

結論：0A完了、0Bは承認workers.dev限定・詳細契約は後続ゲートという条件で完了。S01全体、独立A/Bの通信、参加交換や永続nonceは未完了。1Aへ進む際に追加アカウント・ドメイン購入は必要ない。

## 2026-09-10：コードレビュー3件の修正

検証APIの失敗をHTTP status・code付きの専用エラーとして画面へ表示し、401（トークン不一致）、404（検証API無効）、503（Auth未設定）を区別した。SupabaseのURLまたは公開キーが変わった場合は、旧Authクライアントのdisposeで自動更新・イベント購読等を終了して新しいクライアントへ置き換える。同じ設定なら既存クライアントを再利用する。Viteの開発用TLS証明書読込をcommand=serveに限定し、本番ビルドから分離した。

scripts/check-review-regressions.mjsをpnpm run checkに追加。実装から抽出した実際の処理をテスト応答で実行し、3種類のエラー表示、接続先と公開キー変更時の置き換え・旧クライアント破棄、同設定での再利用を確認した。Vite設定はファイル読込とpluginを差し替え、証明書欠落時もbuildでは読まず、serveでは欠落を検知することを確認。秘密ファイルの移動・削除や実Auth通信は行っていない。

型検査、Workersの39テスト、上記回帰チェック、本番ビルドが成功。今回の修正のクラウド配置および実Google/メールログインの再確認は未実施。ブラウザーの表示確認ではなく処理単位の回帰確認である。
## 2026-09-10：責務分割・比較ページ・入口分離

ユーザー指摘に基づきclientの画面・共通UI・認証・検証・デザインを分割し、workerのprobes/federationを分離した。DOのexport名・binding・保存キーは維持。main.tsxは起動と入口のリダイレクトのみ、TSXは1ファイル1コンポーネント。Prettier 3.9.6を固定し、format/checkへ整形確認を追加した。

/debug/へデバッグ画面を移動し、/からquery/hashを維持してlocation.replaceする。Auth SDKは到着後に初期化する。/design/に4配色・3ボタンと早押し・文字選択のUIサンプルを作成。採用色・ボタンは未決で、ゲーム本体は未実装。

整形・型検査・44テスト・Viteの証明書回帰チェック・ビルド成功。UIの文字列切出し回帰チェックは直接importするtests/client.test.tsへ移行した。Edgeでビルド成果物をローカルHTTP配信し、トップ遷移、401表示、4候補、配色/ボタン選択、Spaceキーの早押し、回答選択、390px幅の横溢れなし・例外なしを確認。1440pxと390pxのスクリーンショットを目視確認した。

実SDKでPKCE生成→別タブのルートcallback→/debug/へ移動→交換・getUser成功、logoutでセッション削除、別ブラウザーの開始情報不足を確認した。Auth通信は全てテスト応答で、実メール送信はしていない。

公開反映：Version ID 39ec4e14-7342-4d05-aeb1-94001ddfc6fb。ユーザーの検証継続希望に従いPROBES_ENABLED=trueを維持。公開Edgeで/→/debug/と/design/の4候補表示を確認。クラウドhealth・DO保存・Alarm・Workers→Node署名・DB commit/rollback・固定egress・未認証401・異Origin403が成功。実Googleログインの再試行は今回行っていない。
## 2026-09-10：Biomeへ移行

Prettier依存・設定を撤去し、Biome 2.5.12を固定。2スペース・90文字・single quoteを引き継ぎ、Tailwind v4・HTML整形を有効にした。対象をコードと指定設定ファイルへ限定。migrateがpreset=noneを生成したため、recommendedへ明示修正し、推奨Lintで検証した。

EffectのrunをuseCallbackで安定化して依存へ追加。命名可能なfigureで配色・回答表示のラベルを表現し、非null断定を明示チェックへ変更した。Lintの一括抑制は追加していない。推奨Lintはエラー・警告なし、型検査・44テスト・証明書回帰チェック・ビルドが成功。今回の変更はクラウド未配置。

## 2026-09-10：参考サイトを基に配色を再検討

ユーザーは段差付きボタンを支持。比較ページのボタンを段差付きに揃え、従来4配色を白×赤・黄×黒・グレー×緑の3案へ置き換えた。色の最終採用は未決。背景を無彩色、問題面を白にし、主操作へ色を集中させる。

- [任天堂](https://www.nintendo.com/jp/)：実サイトの白い情報面と赤の対比を画面確認し、赤い主操作へ応用。
- [LEGO公式ヒストリー](https://www.lego.com/en-dk/history/articles/f-a-modern-international-company)：原色と黒い輪郭を参考に黄×黒を提案。ショップは自動ブラウザーで確認画面となったため、ショップ全体の視覚確認済みとは扱わない。
- [GitHub Primer](https://primer.style/product/primitives/color/)：公式の役割別カラーと白・グレーの情報面を確認し、緑の主操作へ応用。

参考元のロゴや画面は転載せず、リンクと取り入れた点を比較ページに記載。色コードは当アプリ用に調整した値で、ブランド公式値の転記ではない。

Biome推奨Lint・型検査・44テスト・ビルド成功。Edgeで3案の切替、段差付き早押し、文字入力、390pxで横溢れなしを確認。デスクトップスクリーンショットを目視確認。本文・補助文字・主ボタン・得点文字の色ペアは全案4.5:1以上（無効状態を除く）。Authの模擬別タブ復帰も成功し、実メールは送信していない。
公開配置：Version ID 256aca05-ed0e-431c-95de-324da26fd104。/design/が更新後のassetsを返すことを確認。検証APIは有効を維持。Biome移行時の修正も今回のビルドに含まれる。

## 2026-09-11：採用した赤白パレットを見本へ反映

ユーザーが選んだColor Huntの000000/3E3636/D72323/F5EDEDを初期表示に採用。主操作は赤、文字と段差は濃いグレー、問題面には純白を追加した。旧2案は比較用として残し、採用済みであることを画面と仕様に明記した。

Biome・型検査・44テスト・証明書回帰チェック・ビルド成功。再開後、Edgeで3案切替・段差付きボタンのキーボード操作・回答操作・390px幅の横溢れなし・例外なしを再確認し、デスクトップ画面を目視確認。Authの模擬別タブ復帰も成功。実メールは送信していない。

公開配置：Version ID 3aa8c760-4803-49e0-a3a9-a0ebeaf19171。公開/design/が更新後のindex-BOAaW-l0.jsを返すことを確認。検証APIは有効を維持。

## 2026-09-11：赤白の共通テーマ化・見本ページ削除

採用配色をTailwind @themeへ移し、共通Buttonを段差付きに統一。ログインの主操作を赤で表示する。/design/のページ・導線・配色データ・比較部品・専用CSSを削除した。

Biome・型検査・44テスト・証明書回帰確認・ビルドが成功。主操作のtone指定追加後もBiome・ビルドとローカルEdgeの表示確認が成功。背景と主操作・段差の計算済みスタイル、390px幅の横溢れなし、/design/の未検出画面、トップの/debug/遷移、APIエラー表示、模擬Authの別タブ復帰を確認。スマホ画面を目視確認した。実メール送信・Workersへのデプロイは行っていない。

## 2026-09-11：白基調の用途別テーマ

背景・カード・入力欄・通常ボタンを白へ変更し、枠を濃いグレーに統一。入力面と結果表示の色を専用トークンへ分け、結果表示の淡赤と主操作の赤を維持した。

Biome・ビルドが成功。ローカルEdgeで背景・カード・入力欄・通常ボタンの白、濃い枠、赤い主操作と段差、結果表示の淡赤を計算済みスタイルで確認。390px幅の横溢れなしとスマホ画面を目視確認。既存の模擬Auth復帰確認も成功。Workersへのデプロイは行っていない。

## 2026-09-11：Noto Sans JPの導入

Google Fonts CSS APIからNoto Sans JPの400〜800をdisplay=swapで読み込み、Tailwindのfont-sansとbodyに適用。日本語の代替フォントも指定した。

Biome・ビルド成功。ローカルEdgeでGoogle Fontsのフォントがloadedとなり、本文・見出し・入力欄・ボタンの共通指定を確認。390px幅の横溢れなし、既存の模擬認証確認も成功。全Unicode文字の収録・全端末での表示を保証する試験ではない。Workersには未デプロイ。

## 2026-09-11：コンポーネント内Tailwindへ移行

global.cssをテーマと最低限のbase設定へ縮小。Button・TextField・PageHeader・各ページの見た目をTSX内のTailwindクラスへ移した。共通Panelに枠・余白・見出しを集約し、色はテーマ参照を維持する。リセットはPreflightを使用。

Biome・型検査・44テスト・証明書回帰チェック・ビルド成功。ローカルEdgeで配色、段差、Noto Sans JPの読み込みと共通指定、390px幅の横溢れなし、APIエラー、模擬Auth別タブ復帰を確認。スマホ画面も目視確認した。Workersには未デプロイ。

## 2026-09-11：clsx・tailwind-mergeの導入

clsx 2.1.1とtailwind-merge 3.6.0を固定し、src/client/lib/cn.tsへ結合処理を集約。Button・TextFieldで基本クラス、tone、外部classNameの順に結合する。固定クラスのみの箇所は変更していない。

Biome・型検査・45テスト・証明書回帰確認・ビルド成功。追加テストでは実コンポーネントに渡した余白・テーマ色・状態修飾子の上書きと、文字サイズ・文字色・無効状態の維持を確認。ローカルEdgeで配色・段差・フォント・スマホ幅・模擬Auth復帰も成功。Workersには未デプロイ。

## 2026-09-11：Tailwind標準値へ整理

余白・幅・文字サイズ・太さ・角丸・ブレークポイントを標準クラスへ整理。見出しはtext-3xl/sm:text-5xl、ページ幅はmax-w-4xl/7xl、切替はsmに統一した。ヘッダーはflexで構成。採用済みの段差のみshadow-button/pressedをテーマへ定義し、TSX内の任意値クラスを解消した。

Biome・型検査・45テスト・証明書回帰確認・ビルド成功。ローカルEdgeで配色・段差・フォント・390px幅の横溢れなしを確認。Workersには未デプロイ。

## 2026-09-11：意味のまとまりに沿う空行

先にdevelopment.mdへ空行ルールを追加し、client・worker・テスト・スクリプト・設定の宣言間、処理段階、JSXのまとまりを整理した。関連する定数・assert群はまとめ、コメントは対象の処理に隣接させた。

初回編集で空行以外の行を変えていないことを比較確認。Biomeによる整形後、型検査・45テスト・証明書回帰確認・ビルドが成功し、クライアントのJS/CSS成果物名は変更前と同一。最後の空行微調整後もBiome確認成功。動作変更・依存追加・デプロイは行っていない。

## 2026-09-11：ルート定義と処理の分離

app/routes.tsをパスとページ・転送先の宣言一覧に限定し、Appが一覧を参照する。起動時の転送判定はapp/redirect.ts、認証コールバック判定はfeatures/auth/callback.tsへ分離。共用パスはページ依存のないapp/paths.tsに置き、循環依存を避けた。

型検査・45テスト・証明書回帰確認・ビルド成功。整形指摘修正後もBiome・ビルド成功。ローカルEdgeでトップ→debug、未登録ページ、模擬SDKでの別タブcallback→交換→本人確認、logoutを確認。実メール送信・Workersデプロイは行っていない。

## 2026-09-11：Workerルートの責務分離

probes/routes.tsをメソッド・パス・ミドルウェア・ハンドラーの登録一覧に変更。認可をprobes/authorize.ts、検証APIのHTTP処理をprobes/handlers.tsへ分離した。入口index.tsのhealth・404・エラー応答もhttp/handlers.tsへ移し、ルート宣言に統一。DB・署名等の専門処理と認可順序は維持した。

Biome・型検査・45テスト・証明書回帰チェック・ビルド成功。既存のAPI有効判定、トークンとOrigin制限、設定不足、DO保存・Alarm・WebSocketのテストを含む。Workersへのデプロイ・実外部サービスへの追加通信は行っていない。

## 2026-09-11：APIパスの共通化

src/shared/api-paths.tsへ完全なAPIパスと検証APIの接頭辞を集約。clientのfetch・認証設定取得・検証ボタン、Worker登録と認可範囲、CLI検証を共通定義へ移した。Workerの検証サブルートを/へマウントし、URLの二重接頭辞を避けた。既存URL契約を検証するテストのリテラルは維持。

Biome・型検査・45テスト・証明書回帰確認・ビルド成功。ローカルEdgeでAPIエラー表示、トップ遷移、模擬認証の別タブ復帰を確認。クラウドへのデプロイ・CLIによる実外部サービス検証は行っていない。

## 2026-09-11：独自段差のクラス競合を修正

cn.tsでextendTailwindMergeのshadowテーマへbutton・button-pressedを登録。通常時と押下時に外部classNameのshadow-none等が優先されるようにした。

追加テストが修正前に失敗することを確認し、修正後は通常の影・独自の段差の相互上書き、押下時の上書き、影の色クラスと位置移動の維持が成功。Biome・型検査・46テスト・証明書回帰確認・ビルドが成功。Workersには未デプロイ。

## 2026-09-11：1Aのローカル実装・検証

基点は b05668b。検証は1Aの作業ツリーに対して実施。Node 26.8.1、pnpm 10.28.2、既存lockfileを維持し、追加依存なし。1Aの実装・自動検証・Edge操作確認を実施。ユーザーによる読みやすさ・押しやすさ・表示速度の確認を残して区切る。1B以降は未実装。

### 実装と検証結果

- `pnpm run check`：Biome・型検査・5ファイル62テスト・Vite設定チェック・Worker/clientビルド成功。ゲームの追加分は16テスト。既存46テストも成功。
- 独自問題12問をサーバー側へ配置。ルートとハンドラー、裁定と入力検証、画面と接続hookを分離。共通Button/cn()/テーマを使い、global.cssは変更なし。
- ローカルWorkersの実WebSocketで同時buzzと保存後ACKを確認。解答者のみに現在パネルを送信し、他プレイヤーには公開snapshotのみ返る。
- Edge 152.0.4191.66のheadless実行、独立した2ブラウザーコンテキストで、参加→自動出題→Enterによるbuzz→「ニ」「ジ」の選択→正解→両画面の1問終了を確認。
- 1280pxの解答中画面と390pxの出題画面を画像で目視確認。ボタンの段差、押下不可、文字パネルのフォーカスが識別できる。390pxで横方向のoverflowなし。
- 本番ビルドのWorkerをローカルWranglerで起動し、`LOCAL_GAME_ENABLED=true`を指定しても参加APIは404 / LOCAL_GAME_DISABLED。クラウドへのデプロイは行っていない。
- clientの生成JavaScriptに問題本文・mock-01が含まれないことを確認。公開snapshotにも正解・未表示本文・セッショントークンを含めない。例外ログの全異常経路を網羅した検証ではない。

| テストID | 今回の確認範囲 | 残件 |
| --- | --- | --- |
| G01 | 2接続の同時buzzで権利1件、roomSeq更新 | 1Bの試合全体との統合 |
| G02 | 同一内容の再送は同じACK、内容違いは拒否、128件到達時も旧ACKを保持 | 試合全体の保持・復帰 |
| G03 | 別actor・別match・別question・古いパネルを拒否 | 正式認証との統合は1C |
| G04 | deadline直前・一致・直後、Alarm遅延時の入力、重複Alarm | 1Bの復帰との組合せ |
| G08 | 公開データ、本人専用パネル、client成果物を確認 | 全例外ログ・復帰経路の検査 |
| G09 | 選択再送、古いpanelId、非保持者、position追加を拒否 | 差分/snapshot再接続との統合 |
| G11 | NFKC、半角・濁点、小書き・長音、全モックの4択の一意性 | 追加問題や別設定の検証 |
| G12/G13 | 全文後10秒、文字期限、誤答ロック、全文字正解、新パネル期限、残り待ち時間 | 3回失格・次問は1B |
| G17/G18 | 期限切れと再送で加算1回、旧タイマーで新パネルを期限切れにしない | DO復帰の障害統合は1B |
| G19 | 初期3000ms、出題ごとにルールを複製・永続化 | DB設定版の変更は1C以降 |

### 検証時の環境問題と対処

通常のシェルとブラウザー操作ツールはrunner接続に失敗。許可されたサンドボックス外のシェルと、専用の一時プロファイルを使うEdgeで検証した。ブラウザープロファイルを作業ツリー内に置いた初回はViteのwatchでEBUSYとなり、OS一時領域へ移して解消。開発用証明書は検証プロセスだけに公開鍵を指定し、OSの証明書設定は変更していない。

本番ビルド検証用Wranglerを起動したままのビルドは出力先のロックで失敗し、そのプロセスを停止した後、`pnpm run check`全体が成功した。DB/APIの外部通信・デプロイは行っていない。

### ユーザー確認と次段階

[1A操作手順](phase-1a.md)に従い、未使用ルーム1〜13または16で確認できる。文字サイズ、早押し・文字ボタンの押しやすさ、100ms/書記素、1文字3秒の体感を確認する。実機タッチ、Firefox/WebKit、クラウドDOのHibernation、差分復帰・死活監視は未実施。1Bでは次問・7問先取・失格・枯渇・無効化・試合全体の永続化と復帰を実装する。

## 2026-09-11：1Aレビュー指摘2件の修正

ユーザーの基本動作確認と、問題のDB取得を1Cで実装する方針への同意を受領。

- ルーム共通だったコマンド保存上限を、1問・参加者ごとに128件へ変更。1人が拒否入力で上限を消費しても他の参加者はbuzz・文字選択が可能。上限到達後も保存済みACKは再送できる。
- 4つ目の接続は参加時に429 / CONNECTION_LIMITで案内。接続時の上限検査も維持し、競合時に定員超過させない。
- 自動再接続は5回連続失敗で停止し、手動再接続ボタンを表示。確立・初回状態待ちは10秒で打ち切り、状態受信時だけ連続失敗数をリセット。クリーンアップで再試行・監視タイマーを解除する。
- `pnpm run check`成功：6ファイル69テスト、Biome・型検査・設定確認・ビルド成功。追加7テストで参加者別上限、接続上限と解放、再接続停止・成功時リセット・タイムアウト・クリーンアップを検証。
- Edge 152.0.4191.66の一時プロファイルで、同一actorの4タブ目の案内、1タブを閉じた後の参加成功を実操作で確認。検証タブ内だけWebSocketの宛先を存在しないAPIへ変更して5回失敗・停止表示を確認し、元に戻して手動再接続の成功を確認。
- ルーム16を今回の画面検証に使用。デプロイ・DB移行・依存追加なし。1Bには未着手。

## 2026-09-11：1Bの試合進行・復帰

基点は1Aの6a659ba。1Bの作業ツリーで検証。Node 26.8.1、pnpm 10.28.2、既存lockfile・依存版を維持。新しい外部サービス・DB migration・Workersデプロイなし。

- 次問、7問先取、3回お手つき失格、枯渇時の単独勝者/引き分け、接続不足/未失格者不足によるINVALIDを実装。試合結果と理由をDOへ保存し、終了後の入力・再接続で終端を変更しない。
- 公開差分を60秒・512件保持。matchId/lastSeqを検査し、復元不能ならsnapshotへ戻す。パネルは本人のみ。試合中のコマンド保持は参加者ごと256件へ拡張。
- `pnpm run check`：Biome・型検査・7ファイル85テスト・Vite設定確認・Worker/clientビルド成功。
- Edge 152.0.4191.66のheadless・独立コンテキストで、2人が7問先取まで進行し、両画面の勝者と終了後切断でも結果維持を確認。
- 3人対戦で、解答者が「ニ」を選んだ後に再読み込みし、2文字目「ジ」のパネルから正解まで進行。残りの接続が1人になると無効理由を表示。
- 別の3人対戦で3問にわたり誤答→他者正解を反復。3回目の失格、次問の継続、失格者のbuzz禁止、再読み込み後の失格保持を確認。
- 勝利画面のスクリーンショットを目視し、問題番号・得点・終了理由・DB未保存の表示を確認。ブラウザー検証は1Bルーム13〜15を使用。1AとはDO名を分離し旧データを保持。

| ID | 今回確認した範囲 | 残件・境界 |
| --- | --- | --- |
| G01〜G04・G09・G11〜G13・G17〜G19 | 既存裁定・入力検証を全体チェックで回帰。次問後も旧commandIdのACKと二重加点防止を確認 | DB設定版変更との統合は1C以降 |
| G05/G15/G16/G20 | 次問のロック解除、7問先取、3〜4人で失格後の継続、2〜4人の人数不足、枯渇時の勝者/引き分けと優先順位を状態裁定テストで確認。7問先取と3人の失格継続は実ブラウザーでも確認 | 枯渇・4人操作のブラウザーE2Eは未実施 |
| G06 | 公開差分とsnapshotの一致、履歴期限/上限/欠落、別matchを検証。実ローカルDOの3人接続で切断・再接続と差分、別matchのsnapshot取得 | クラウド・実回線断のE2Eは未実施 |
| G07/G10/G18 | cloudflare:testのevictDurableObjectでローカルDOメモリを破棄。2文字目のパネル/位置/期限、ACK、連番を保存から復元。ブラウザー再読み込みからの解答継続も確認 | ブラウザー再読み込みとDO evictionは別の検証。クラウドHibernationは未実施 |
| G08 | 公開イベントに問題解答・非公開パネルを含めないこと、実ブラウザーで他者パネル非表示を確認 | 全例外ログの網羅検査は未実施 |
| M02/M04/M05 | 実ローカルDOで同一actor複数接続、最後の接続を閉じてINVALID、eviction後も無効を保持。heartbeatを期限切れにしてAlarmから人数不足を検知。裁定テストで最終解答と切断の前後順・全員切断・待機中の例外を確認 | 実ネットワーク遮断・負荷下の検知遅延計測は未実施 |
| M06 | 未失格者が2人なら継続、1人/0人ならINVALID。接続と失格の別条件を確認 | DB集計D06〜D08は1D |

[1B操作手順](phase-1b.md)を追加。1Bのローカル実装・検証を完了し、ユーザーによる操作確認を待つ。正式認証・自動マッチング・DB問題取得は1C、結果のDB保存・順位・効果音は1D。MVP全体やクラウド受入完了とは扱わない。

## 2026-09-11：1Bを検証専用Workersへ配置

ユーザーがWorkersへの配置を明示指示し、未コミットの1B実装・PROBES_ENABLED=trueの維持について「検証のためのworkersなので問題ありません。本番環境ではないためエンドユーザーも存在しません」と承認。既存のquiz-relay-probeへビルド・配置した。

- Version ID：db83bf9c-a699-4b75-9000-cae5e945356c。
- 公開先：https://quiz-relay-probe.quiz-relay.workers.dev/ 。/api/health、/game/、更新後のindex-ZUkTik-b.jsがHTTP 200。
- 検証APIは有効を維持し、未認証の/api/probes/statusは401 / UNAUTHORIZED。
- 開発用参加APIは引き続き本番ビルドで無効。POST /api/game/joinは404 / LOCAL_GAME_DISABLEDを確認。公開先での対戦・ゲームDOのクラウド復帰を検証したものではない。
- ビルド成功。直前の1B全体チェックは85テスト成功。今回DB・Authの再検証やコミットは実施していない。
## 2026-09-13：選択文字の共有設定・ひらがな化

- 回答・ダミー候補をひらがなへ変更。試合共通showSelections（初期値オン）を参加画面に追加。設定不一致・非boolean入力は拒否する。公開responseには受理済み文字だけを記録し、オフではsnapshot・差分へ履歴を含めない。
- 次のbuzz・次問で表示をリセット。誤答文字は判定中も表示。再送で二重追加せず、ローカルDO eviction後も選択済み文字・パネル・期限を復元。
- pnpm run check成功：Biome・型検査・7ファイル87テスト・Vite設定確認・ビルド。追加した2ケースで共有オン/オフ、差分一致、誤答表示、再送、表示リセットを確認。ひらがな候補と入力設定検査、DO復帰時の他者への表示確認も既存テストへ追加。Biomeの情報指摘1件を修正後、lintを再実行して指摘なし。
- Edge 153.0.4234.32の独立コンテキストで、共有オン・オフの各2人対戦を操作。ひらがな「に」「じ」の選択、他者の共有表示/非表示、正解表示を確認。共有オンの他者画面を画像で目視確認。
- 新版のローカルDO名は1b-hiragana:room-N。旧版の試合を変換・削除せず、タブの保存キーも分離。新版ルーム13・14をブラウザー検証で使用。
- 新規依存・global.css変更・DB変更・追加デプロイ・コミットなし。Workersの公開版には今回の変更をまだ反映していない。
## 2026-09-13：30秒の切断復帰猶予

ユーザー指定で30秒の復帰猶予を追加。人数不足時に一時停止する方式を提案し、その前提で実装。接続中actorが1人以下ならゲーム期限を停止し、30秒未満に2人以上へ戻れば残り時間から再開。2人以上残る切断では進行継続。未失格者不足は即時INVALIDを維持。

- pnpm run check成功：Biome・型検査・7ファイル93テスト・Vite設定検査・ビルド。
- 出題・文字解答・判定表示それぞれの停止/再開、猶予を繰り返し検査しても延長しないこと、期限一致/超過の復帰拒否、同一actor複数タブ、全員切断を確認。
- ローカルDO eviction後の猶予期限保持、同じパネルの復帰、Alarmでの猶予切れ無効化と終端維持、heartbeat無応答検知から猶予開始を統合テストで確認。期限切れテストでは保存期限を過去へ設定しAlarmを実行。
- Edge 153.0.4234.32、独立2コンテキストの実操作で、2文字目に相手を別ページへ移動し、4秒間ゲーム期限・選択パネルが停止。元のページに復帰後、同じ2文字目で正解。続けて相手タブを閉じ、実時間30秒の猶予後に理由付きINVALID表示を確認。
- ひらがな版ローカルルーム15を今回使用。新規依存・DB変更・デプロイ・コミットなし。クラウドでの切断復帰検証は未実施。
## 2026-09-13：接続レビュー指摘2件の修正

- 初回state/delta受信後も15秒の受信監視を継続し、有効な状態受信で更新。無応答時はcloseイベントを待たず再試行する。
- 再試行を連続5回から切断検知後30秒へ変更。有効な状態受信で再試行期間を解除し、次の切断では新しく計時。1008の即時停止・手動再接続は維持。
- pnpm run check：Biome・型検査・7ファイル95テスト・Vite設定検査・ビルド成功。接続テストを5件から7件へ更新した。
- 偽時計と模擬WebSocketで、状態受信後の無応答、監視更新、ACKでは更新しないこと、closeイベントなしの再接続、古い接続からの遅延イベント無視を検証。18秒間に12回失敗した後の復旧、状態未受信なら猶予をリセットしないこと、30秒で進行中の試行と全タイマーを停止することも確認。
- 今回の修正は自動テストで確認。ブラウザーの実ネットワーク遮断・クラウド試験は未実施。依存追加・デプロイ・コミットなし。
## 2026-09-13：1Cの第1区切り・DB固定版の基盤

引継ぎ開始時のHEADはf157236、Git作業ツリーはclean。引継ぎ要約の未コミット状態ではなく、実際のGitと最新文書を確認して着手した。

- quiz_gameの固定ルール・問題・セット・大会・停止状態を扱うmigration、読取専用quiz_game_reader、RLS/grantsと不変版triggerを追加。**実DBへの適用・権限検証は未実施**。
- 既存の独自モック12問を出典・許諾・ダミー候補とともにDBへ登録するseed SQL生成スクリプトを追加。node scripts/game-catalog-seed.tsに既存検証Workerのoriginと仮値2人を渡し、Git管理外の.wrangler/qa/game-catalog-seed.sql生成を確認。DBへの投入ではない。
- 専用GAME_DATABASE_URL/GAME_HYPERDRIVEで固定版を読むサーバー処理と、hash・候補数・文字・版・停止状態の検証を追加。検証用DATABASE_URLへの流用や、DB障害時のコード内モックへのフォールバックは行わない。
- 裁定へ渡す固定定義を複製し、設定した候補数・時間と非公開候補を使用。G14の一部として6択・5秒の解答、旧試合の4択・3秒維持、設定/問題/版参照の非遡及、不足候補・重複・不正値・hash改変拒否を検証。
- SQL接続をモックした読込テストで、正常な定義の取得、欠落・停止・hash不一致・接続失敗の拒否と接続解放を確認。**SQL構文、制約、RLSを実DBで検証したものではない**。実DB用のsupabase/tests/game_catalog.sqlとscripts/check-game-catalog.tsを追加。
- pnpm run check成功：Biome・型検査・8ファイル100テスト・Vite設定確認・ビルド。既存1Bの試合裁定・切断復帰・公開境界テストも回帰した。
- ローカルにpsqlは見つからず、Docker CLIはあるがdaemon未起動。新しいサービス起動・依存追加・既存DB権限変更・秘密変更・デプロイ・コミットなし。

開始人数の初期値/範囲とDB管理者接続の利用方法はユーザー回答待ち。正式メール/Googleログイン導線、参加認可、自動マッチング、開始直前のDB再確認への接続は未実装であり、現在の/game/は引き続き1Bの開発用経路・コード内モックを使う。1Cを完了とはしない。[1C手順](phase-1c.md)に実装順序・適用手順・残件を記載した。

## 2026-09-13：開始人数4人とコンフィグ指定

ユーザー回答により初期人数を4人に確定し、Supabase操作の一任を受けた。

- config/matchmaking.jsonへplayersPerMatch=4を追加。初期seed生成と開発用の仮参加UIの初期値を共通化した。検証用・サーバー固有の値はseed生成時に別JSONを指定できる。現行範囲は2〜4人。稼働中の人数は大会のDB固定版を正とし、JSON変更を既存待機列・試合へ遡及させない。
- 旧2人用SQLを保持したまま、.wrangler/qa/game-catalog-seed-4.sqlを生成。実DBには未適用。
- pnpm run check成功：Biome・型検査・8ファイル100テスト・Vite設定確認・人数コンフィグのCLI検証・ビルド。CLI検証では初期4人、別設定2/3人、不正値1/5/文字列/nullの拒否、既存SQL上書き拒否を確認。今回の仮UI初期値は型検査・ビルドまでで、ブラウザー操作は未実施。
- ブラウザー操作ツールは初回とreset後ともrunner pipe-in接続タイムアウトで起動できず。Supabase CLI・管理者接続・環境変数のPATを利用できなかった。Git管理外の.env.supabase-adminへ空のSUPABASE_ACCESS_TOKEN欄を用意し、本人による登録を依頼。秘密値は出力していない。
- 既存DB・Auth設定、Worker配置、旧DO保存データに変更なし。正式認証・マッチングへの統合は未実装。人数の未確定事項は解消したが、実DB検証は管理用接続の登録待ち。

## 2026-09-13：1CカタログをSupabaseへ適用・専用reader検証

ユーザーが管理PATのローカル登録を完了。Supabase操作の一任に基づきManagement APIのSQL実行で作業した。ブラウザー操作は使用していない。

- 事前照会でquiz_probeあり、quiz_game/quiz_game_readerなしを確認。supabase/migrations/202609130001_game_catalog.sqlと4人用seedを適用。既存スキーマを変更せず、6テーブル・不変版trigger・RLS・reader用SELECT policyを追加。
- demo版1・開始4人・独自問題12問を実DBで確認。Nodeのscripts/check-game-catalog.tsでreaderからSupavisorへTLS接続し、アプリケーションのloadMatchDefinitionで全問題とルールを読込・hash検証した。rulesHashは95979f74691dd73cfa9645f4572a572c809c93bad72bc0812673e0db30cb5209、manifestHashは1d6811bf21c02f97ca3021375abbcad2c33895ffbe8f328957f5f86032cca4af。
- 新規quiz_game_readerに暗号学的乱数の資格情報を設定。SQLへ平文パスワードを含めずSCRAM verifierを使用。既存DATABASE_URL/ロールのパスワードを保ち、.dev.varsへGAME_DATABASE_URLを追加。検証完了後、今回作成したreader用の一時資格情報ファイルは削除。
- 初回SQLテストはManagement APIのpostgresから新規readerへSET ROLEできず42501。テストを管理者のSQL確認とreaderの実接続へ分離して再実施した。権限を追加してテストを通す対応は行っていない。
- supabase/tests/game_catalog.sql成功：anon/authenticatedの実行権限で問題本文・解答を含むpayloadの読取拒否、全テーブルのRLS・grants、ルール版の更新/削除/重複拒否。テスト一時行はrollback後0件。
- scripts/check-game-reader.mjs成功：実セッションcurrent_user=quiz_game_reader、問題SELECT成功、INSERT/UPDATE/DELETEは42501、quiz_probe.runsの読取も42501。書込検証はWHERE falseで既存データへ影響させない。
- pnpm run check成功：Biome・型検査・8ファイル100テスト・Vite設定検査・コンフィグCLI検証・ビルド。

実DBは既存のSupabase開発プロジェクト。今回確認したアプリケーション読込経路はNode→Supavisorで、Worker経路やクラウドGAME_HYPERDRIVEからのゲームDB読込ではない。Workersデプロイ、正式ログイン・自動マッチング統合、ゲームHibernationは未実施。完全な空Supabaseプロジェクトでの再構築も未実施。直接SQLでの適用のためSupabase CLIのmigration履歴は未登録。現行/game/は引き続き1Bの開発用経路とコード内モックを使う。1C全体の完了とはしない。[1C手順](phase-1c.md)を更新。


## 2026-09-14：1C正式参加・マッチング・実DB統合

1BのHEAD f157236を基点とする未コミット作業ツリー。正式/game/と開発/local-game/を分離し、既存の1B保存データは保持。デプロイ・コミットは未実施。

| 対象 | 実施結果 | 限界 |
| --- | --- | --- |
| A04 / 認可 | 公開設定、サーバーgetUser、未認証・匿名・未確認email・偽造actor拒否、HttpOnly cookie、ログアウト後の旧cookie拒否と同一actor復帰を自動検証 | 有効ユーザーのSupabase応答はモック。本人OAuth/メールE2Eは未確認 |
| M01/M03 | 2/3/4人の接続完了で一度だけ開始。同一actor複数タブ、定員、開始後新規拒否、取消競合、同時10参加の4/4/2割当、異なる版の待機分離 | ローカルDO、性能負荷試験ではない |
| 予約・復帰 | 未接続60秒・待機10分の期限、永続化後RPC応答消失、同じ予約での復帰、stale取消拒否、actorごとの復帰ストレージ分離 | クラウドHibernation未実施 |
| G14 / 開始前DB検証 | 一時DB障害でWAITING維持・問題非公開、出題停止で部屋閉鎖、既存固定版維持 | 障害入力はモック |
| D05 / 実DB・Worker統合 | 専用readerで実Supavisorの4人/12問定義を読込。隔離した実ローカルDOへ4人接続し、最後の接続でDB再検証後REVEALINGになることを確認 | 本人ログインは介さないSELECTのみの明示試験 |
| ログイン前UI | Edge 153 headless、1100px/390px幅で正式ログイン、ルートredirect、email/Google操作導線、横あふれなし。モバイル画像を目視確認。実HTTPで公開設定200、未認証401、Supabaseでの実無効JWT401 | 本人認証ダイアログ操作・ログイン後対戦E2Eは未実施 |

実DB試験は最初にCA未読込で接続失敗。Node起動時に.dev.varsを読み込み、既存CAを維持して解消。次にPostgres.js 3.4.9の接続終了競合による未処理例外を2件検出し、上流issue #1196と照合した。pnpmの最小パッチ後、tests/catalog.live.tsは1テスト成功・未処理例外0。TLS検証無効化や全体の例外抑制は行っていない。

ブラウザー成果物はGit管理外の.wrangler/qa/1c-login.pngと1c-login-mobile.png。本人認証には通常ログインを使用する。管理キー取得によるテストユーザー準備は自動承認レビューで拒否され、取得・作成は行っていない。

1Cの実装はそろったが、本人によるメール/Googleログインから複数アカウント対戦までの受入は残る。クラウドGAME_HYPERDRIVE・配置・ゲームHibernation、1Dの結果/outbox保存・順位は未実施。今回の変更にクラウドのPROBES_ENABLEDや配置Versionの変更はない。

最終全体チェック（2026-09-14）：pnpm run check成功。Biome・型検査・9ファイル117テスト・Vite設定/seed CLI検証・本番ビルドが成功。git diff --checkで差分エラーなし。実DB試験1件は通常の117件とは別枠。

2026-09-14：demo版2（検証用2人）を追加。実DBのSELECTで版1=4人・版2=2人の共存を確認。tests/catalog.live.tsを両版へ拡張し、ローカルWorker→実DBで4人/2人の自動開始をそれぞれ確認、2テスト成功。ローカルのみ版2へ切替、既存試合・クラウド配置は変更なし。


## 2026-09-14：ユーザー確認と1Cレビュー修正

ユーザーから「アカウントと自動マッチング確認しました」との報告を受領。認証方式別結果や対戦完走までの確認とは解釈しない。

- DB応答を16秒遅らせたローカルDO試験で、heartbeat送信中もWAITINGのままになる問題を修正前に再現。DB読込を直列化区間の外へ移した後はREVEALINGへ遷移して成功。
- DB返答待ちの間に、接続要求者の取消、相手の取消、待機期限切れ、別接続による開始を起こし、返答後も古い状態を上書きしないことを確認。開始済みの試合を遅延DBエラーで閉じない。
- NO_ACTIVE_MATCH時に古い参加情報を解放。一時障害とunmount後の遅延応答で解放しないことをhook試験で確認。
- Edge 153 headlessで実React画面を検証。Auth・復帰応答・WebSocketを模擬し、古いREVEALING snapshot＋参加なし応答からマッチング画面へ戻り、sessionStorageも消えることを確認。一時障害では古い情報を保持。実認証E2Eではない。再現スクリプトはGit管理外の.wrangler/qa/1c-expired-room-browser.mjs。
- 2人のローカル設定、4人の初期設定とDB固定版は保持。クラウド配置・コミットは行っていない。

修正後の最終確認：pnpm run check成功（Biome・型検査・10ファイル125テスト・Vite設定/seed CLI検証・ビルド）。別枠の実DB試験も2件成功し、2人版・4人版とも開始前再検証から自動開始を確認。


## 2026-09-14：ハードコード問題の撤去

ユーザー依頼により、アプリ内の12問定義を撤去。初期投入用JSONとテストfixtureへ分離し、裁定関数から暗黙の問題セットを削除。旧開発参加の新規部屋もDBから読むよう変更。既存DB・保存済みDOは変更しない。

追加の回帰検証は、DBにしかないID/本文の受渡し、既存部屋のDB非依存復帰、DB障害時に空の部屋を作らないこと、空問題セット拒否。正式対戦の開始・取消・復帰も全体チェックで確認する。

撤去後の最終確認：pnpm run check成功（10ファイル127テスト、型検査、Biome、seed CLI、Vite設定確認、ビルド）。実DB試験3件で正式2人/4人開始と旧検証のDB読込を確認。初期投入JSONのmanifest hashは既存DBの記録と一致し、12問のID・本文がWorker/clientビルドに含まれないことを確認。DB書込・デプロイ・コミットなし。

## 2026-09-14：JSON設定とDB有効版切替

- `pnpm run check` 成功：Biome、型検査、11ファイル134テスト、seed CLI・Vite設定確認、ビルド。設定JSONの初期4人/ローカル2人、不正な人数・欠落・誤記・型、変更ルールでの勝利と旧試合への非遡及を確認。
- 実Supabaseへ設定参照migrationを直接SQLで適用し、CLIでdefault（demo版1、4人）とlocal（版2、2人）を登録。既存ルール・大会版を再利用、問題の更新なし。Supabase CLIのmigration履歴へは未登録。
- Git管理外の検証スクリプトでCLIの生成SQLを使い、3人・5問先取・2回失格・20秒猶予へ一時変更。同一TX内の2回適用でも新規ルール・大会は各1版だけで、参照先と値が一致。rollback後、元の件数と検証プロファイル不在を確認。
- readerの実TLS接続・SELECT成功、INSERT/UPDATE/DELETEとprobe読取拒否、追加した設定参照テーブルへのUPDATE拒否を確認。
- 明示実DB試験3件成功：固定版1の4人、版2の2人でローカルWorkerの開始、旧検証経路の有効プロファイルからの問題取得。本人認証E2Eとは別の試験。
- クラウド設定・配置・PROBES_ENABLEDを変更していない。管理画面未実装、コミットなし。現在のローカルは引き続き2人。
- 設定JSONをBiome対象へ追加後、97ファイルのLint成功。追加文書のリンクとgit diff --checkを確認。開発サーバーを新しいlocalプロファイル設定で再起動し、/game/のHTTP 200とアプリ入口を確認した。本人ログインの再実施とは区別する。

## 2026-09-14：Drizzle ORM / Kitへの移行

- Drizzle ORM 0.45.2 / Kit 0.31.10を固定。ゲームの1クエリ読込、設定反映、初期seed、DBプローブをDrizzleへ変更。自前SQL文字列生成・エスケープ・設定CLIのManagement API送信を撤去。
- 実DBの8テーブルをKit pullで取得し、列・PK/FK・CHECK・ポリシーを照合。取り込みのRLS明示フラグを補い、旧権限試験と不変トリガー5件・関数内容を確認。初期2migrationを再実行せずDrizzle履歴へ登録し、専用writer/RLSの3migrationを実適用した。
- セッション接続でKit introspection成功。トランザクションプールでは途中で完了しなかったため対象プロセスだけ停止した。既存のSupabase管理パスワードを使用し、読取・probe資格情報は変更していない。writer資格情報はGit管理外に新規保存。
- `pnpm run check` 成功：11ファイル134テスト、型検査、Biome、seedプレビュー/既存hash一致、Vite設定、Worker/clientビルド。後から追加したCLI TSも型検査を通過。
- ローカルWorker＋実DB試験3件成功：既存4人/2人の固定版開始、旧開発経路の有効設定読込。実AuthのE2Eとは別。
- `pnpm db:check` 成功：専用writerで新規ルール・大会版を作成し、同設定の再適用で版が増えないことをTX内で確認してrollback。別接続の同時反映は同じ既存版を再利用し、一時プロファイルを削除。readerの書込/他スキーマ読取拒否、writerの過去版・問題変更拒否、管理者の不変版更新拒否を確認。
- `config:apply:local` / `config:apply:default` を実行し、demo版2/2人と版1/4人を再利用。問題・既存試合の変更なし。
- 全migrationを隔離したスキーマ・ロール名に置き換え、実DBのTXで全DDL statementを実行しrollback。スキーマ・ロールが残らないことを確認。標準migratorを外側TXへ入れる方式はPostgres.jsのネスト制約で失敗したため、このDDL検証はstatement単位で行った。実DBへの通常適用は標準Drizzle migratorを使用し、再適用が無変更、Kit generateが差分なしを確認。
- クラウド配置・コミットなし。旧SQLは履歴照合資料として保持し、通常運用は[DB管理](database.md)のDrizzleコマンドを使う。
- 最終確認：103ファイルのLint、追加文書リンク、git diff --check、Drizzleの実DBプローブcommit/rollback/後片付け、全5件のmigration履歴hash一致、ビルドへの問題ID・本文非同梱を確認。開発サーバーを再起動し/game/のHTTP 200を確認した。

2026-09-14追記：前項で照合資料として残した旧supabase/migrations、supabase/seeds/demo-two-player.sql、supabase/tests/game_catalog.sqlを削除。権限試験の全7テーブルRLS/grants、anon/authenticatedの実読取拒否、試験用ルール版のUPDATE/DELETE/重複拒否をDrizzleのscripts/check-game-permissions.mjsへ移し、実DBで成功・TX rollbackを確認した。pnpm db:checkへ追加。2人設定は既存JSON＋config:apply:local、migrationはdrizzle/へ統一。既存DBデータとDrizzle適用履歴は変更していない。過去のファイル名が出る実施記録は当時の記録として保持する。

## 2026-09-14：再レビュー2件の修正検証

- 標準JSONから検証項目一覧を作る処理を撤去。必須項目・型・上限下限を固定契約にし、標準JSONにも適用。各必須9項目の削除と未知キー追加をモジュール読込時に拒否する10件の回帰テストを追加。
- MatchmakerのDB読込を直列化区間外へ移動。応答保留中の別actorの復帰・取消・Alarm、後発同一actor参加による二重予約拒否、後発参加取消後の古いDB返答による再参加拒否を確認。
- DB障害を捕捉し503 / GAME_DATABASE_UNAVAILABLEと再試行案内を返す。cookie未発行・既存予約保持・回数加算1回を確認。初回試験で検出した未処理RPC例外も解消。
- pnpm run check成功：12ファイル149テスト、105ファイルのBiome、型検査、seedプレビュー・Vite設定確認、ビルド。git diff --check成功。
- 今回はローカルDOとDBモックで競合を検証。実DB・migration・設定値の変更、クラウド配置、コミットなし。先の実DB試験・migration履歴確認とは区別する。

## 2026-09-14：追加手動確認・既存クラウド基盤の再検証

ユーザーがアカウント・自動マッチングに加え、案内したその他の手動動作も確認したと報告。ログイン方式別の個別ログや動画を取得したものではなく、ユーザー報告として記録する。クラウド・Hibernation検証の実施依頼を受領した。

- ローカル：pnpm run check成功。Biome 105ファイル、型検査、12ファイル149テスト、Vite設定・seed preview・ビルド。
- 既存クラウド：scripts/probe.mjsによりhealth、DO保存、Alarm、Workers署名のNode検証、probe用HyperdriveのDB commit/rollbackがPASS。
- 既存Probe DOのHibernation：2026-09-14 14:00 JST、30秒無通信の前後で同一WebSocketが開いたまま、count・connectedAt attachmentが一致、instanceIdが変化。DO再生成と保存状態・attachment復元を確認。再配置や強制再起動は行っていない。Git管理外の.wrangler/qa/cloud-probe-hibernation.mjsと.wrangler/qa/cloud-probe-hibernation-result.jsonに実行用コード・非秘密の結果を保存。
- この結果は既存Probeの実測であり、GameRoomのパネル・得点・猶予復元や1Cクラウド完了の証拠にはしない。

ゲーム用Hyperdriveの作成・reader資格情報登録は、自動承認レビューが具体的な機密情報の外部登録とリソース追加の明示承認不足として実行前に拒否。資格情報送信・新規リソース作成・Worker配置は未実施。既存PROBES_ENABLED=trueを維持。GAME_HYPERDRIVE、最新1C配置、ゲーム本体のクラウド復帰検証は承認後の残件。

Hibernationの判断は[Cloudflare公式のWebSocket説明](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)に沿い、接続維持だけでなくインスタンスの再生成とattachment保持を照合した。

## 2026-09-14：1Cクラウド配置・Hibernation・対戦完走

ユーザーがHyperdriveへの専用reader資格情報登録と追加を承認。作成時の接続確認が成功。quiz-relay-game-db IDは4e4a5dbafb8540a1aa13241013dc90c6。Supavisor session 5432、既存CAによるverify-full、キャッシュ無効、接続上限5。既存probe用Hyperdrive、ローカルDB設定、過去版・旧DOは維持。有料プラン変更なし。

pnpm run check：Biome 105ファイル、型検査、12ファイル149テスト、Vite設定、seed preview、ビルドが成功。vite.config.tsへGAME_HYPERDRIVEを追加したビルドをPROBES_ENABLED=trueで配置。quiz-relay-probe Version b35b5779-c36a-4c92-8f66-cb15801c67fa、標準default=4人。ローカルlocal=2人は不変。

| 対象 | 実測結果 |
| --- | --- |
| 公開配置 | /game/、/api/health、/api/auth/configは200。未認証のPOST matchmaking join/configは401、開発game joinは404 |
| 既存probe | health、保存、Alarm、Workers署名、DB commit/rollbackがすべてPASS。PROBES_ENABLED=trueの維持を確認 |
| 同じソースの隔離DO・待機中 | 11秒無通信後、同じWebSocketはOPENのまま、同じmatchId、観測用メモリinstance IDは変化。Hibernation後の接続維持を確認 |
| 同じソースの隔離DO・一時停止 | 全員切断して停止後、11秒の休止を挟んでinstance ID変化。パネル全体とreconnect期限・残時間は一致 |
| 隔離DO・再接続 | 期限内に2人へ戻り停止解除。同一panelId・候補と保存済みbuzzのACKを復元。Matchmakerの同じroom/tokenへ復帰 |
| 隔離DO・猶予満了 | 再度全員切断後、保存した30秒の期限を越えてAlarmでINVALID。instance ID変化を確認。後から接続しても同じresultを維持 |
| 隔離DO・参加制御 | 二重参加ALREADY_JOINED、開始後の新規reserveはROOM_CLOSED、待機取消後resumeはNO_ACTIVE_MATCH |
| 通常配置の実DO・RPC | quiz-relay-probeの隔離Matchmaker名経由で4人が同部屋へ入り、全員接続後に自動開始。DBの7問を正解してtarget_reached勝利。終了後再接続のresult一致、次の新規部屋と取消も成功 |

通常配置DOの試験は一時Workerの同一アカウントDO binding経由。ユーザーの通常待機列とは別の名前で、認証済みactor相当の検証IDをRPCへ渡した。実Auth・cookieのクラウドE2Eとして扱わない。クラウドの本人メール/Google操作は今回再実行していない。ユーザーの追加手動受入報告と合わせて1Cの予定範囲を完了とし、結果DB保存等の1Dへは着手していない。

一時Worker quiz-relay-game-qaは観測用GameRoomサブクラス（メモリinstance IDと保存状態の読取りのみ）を使用し、元の裁定・時間設定を変更していない。既存トークンの流用は自動承認レビューで拒否されたため実行せず、新規専用ランダムトークン方式で保護。未認証の一時APIは404を確認。試験後にWorkerを削除し、ローカル専用トークンも削除した。既存検証トークンは維持。

再現用の一時コード・非秘密の結果はGit管理外の.wrangler/qa/cloud-game-{worker.ts,test.mjs,result.json}、cloud-deployed-game-{test.mjs,result.json}、cloud-public-check.mjs。再実行には一時Workerと新規専用トークンを用意し、確認後に削除する。試験は短時間・少人数であり、負荷・長時間耐久試験ではない。

## 2026-09-14：1D第一段（結果保存・レート・本人履歴）

ユーザーがサーバー全体のレート方式を承認。初期1000、通常勝者+20・敗者-20、引き分け0。未復帰/失格の-20を優先。INVALIDは接続中かつ未失格だけ+20、全員切断は全員-20。カジュアル/部屋建ては影響0。旧得点案とINVALID全除外を置換。競技の7問先取等は維持。

### 実施済み

- `pnpm run check`：Biome 119ファイル、型検査、14ファイル159テスト、Vite設定/seed preview検証、ビルドが成功。
- Workersローカルの新規10テスト：レート条件、終端時の接続状態固定、全員切断、一時切断復帰、旧DO除外、DB停止・DO退避/復帰・commit後の応答消失を模した再試行、競合時の原本保持、DB保留中のDO操作、履歴APIのOrigin/認証/actor固定/503。
- 実Supabase/Postgresの新規0005〜0007 DDLを隔離スキーマのTXで適用してrollback。その後通常Drizzle migrationで実DBへ追加。既存問題・固定版・設定を変更せず、初期seedは再投入していない。
- quiz_game_resultsの新規ランダム資格情報をローカル.dev.varsへ設定し、専用接続を確認。管理用接続や既存readerを結果書込みに転用していない。外部サービスへの資格情報登録はしていない。
- `pnpm db:check:results`：専用writerによる実commit、別接続の同時再送、result/outbox各1件、内容相違・同一match別IDの拒否、途中INSERT失敗の全rollback、順位1,1,3,3、casual除外、開催元分離、writer/readerのUPDATE拒否・readerのoutbox読取/INSERT拒否、管理接続への不変保護を確認。anon/authenticatedは内部schemaの権限設定を検査。
- `pnpm db:generate`：変更なし。`pnpm db:check`：既存設定反映・reader・権限・RLS・不変版の回帰が成功。権限試験の期待値を内部7表から10表へ更新し、outboxはreaderへ公開しない条件を追加。
- 実commit試験は一意なqa-UUID.invalid ownerを使用。成功した最終試験ownerは `https://qa-cc1f0aee0aec48b9962825dcd90c50c8.invalid`。途中の試験でcommitした検証原本も不変保護のまま残す。通常GAME_OWNERの順位・履歴には含めない。

DOのDB障害はモックによる注入、実Postgres試験はNodeからの実接続であり、Workerから実DB保存までを通したクラウドE2Eではない。読み取りはrepeatable readの同一snapshotで順位と履歴を返す。

### 未実施・残件

ブラウザー操作ツールを2回試したが、sandbox runnerへの接続タイムアウトで起動できなかった。今回の結果画面・履歴画面の目視、本人ログインからのローカル対戦完走は未確認。手動手順は[1D手順](phase-1d.md)へ記載。

Cloudflareの結果writer登録、RESULT_HYPERDRIVE追加、今回のWorker配置とクラウドAuth/cookie E2Eは未実施。既存クラウドVersionとPROBES_ENABLED=trueを維持。問題・セット・ルールの最小管理、音源対応設定・ミュート・文字送り音は次の区切り。1D全体の完了ではない。

## 2026-09-14：レビュー指摘・履歴更新の競合を修正

useResultsの手動要求にキャンセル管理がなく、確定時の自動要求より後に返った古い応答で履歴・順位が巻き戻る問題を修正。手動/自動に共通のAbortControllerを持ち、次の要求とeffect cleanupで前の要求を取り消す。キャンセル済み要求は成功・失敗・finallyのすべてで状態を更新しない。

tests/results-client.test.tsに4件追加。実際のhookをimportし、Reactの状態/effectと通信をモックして、古い成功・失敗応答、読込中状態の保護、画面破棄時の手動要求の取消を検証。ブラウザーDOMの確認とは区別する。

`pnpm run check`成功：Biome 120ファイル、型検査、15ファイル163テスト、Vite設定/seed preview、ビルド。`git diff --check`も成功。今回DB変更・実DB試験・デプロイは行っていない。

## 2026-09-14：1D第二段・最小管理CLI

専用管理CLIから問題登録・新ID改訂・使用停止、順序付きセット版、ルール/人数/使用セットの反映と一覧を実装。開催元をcatalog_operatorsでDBロールに対応付け、操作認可とRLSで制限する。管理画面は今回の対象外。

### 実施済み

- `pnpm run check`：Biome 125ファイル、型検査、16ファイル177テスト、Vite設定/seed preview、ビルドが成功。入力形式・不正操作・開催元不一致の検証を14件追加。
- `pnpm db:check:catalog:ddl`：全migrationを隔離スキーマ・ロールで適用し、全体をrollbackして成功。その後0008〜0010を通常Drizzle手順で実DBへ適用。
- `pnpm catalog:setup --apply`：専用quiz_game_catalogを開催元へ登録し、新規資格情報をローカル.env.supabase-adminへ保存。再実行で接続・認可を確認し、既存資格情報を保持。Workerや外部サービスへ資格情報を登録していない。
- `pnpm db:check:catalog`：登録/改訂/停止と再実行、同ID競合、旧問題・セット・ルールの保持、セット順序、人数/ルール反映、改訂途中失敗の全rollback、別接続との開催元ロック排他を実Postgresで確認。他開催元への操作・直接INSERT、原本UPDATE/DELETE、結果表読取、所有者対応の変更、readerによる管理を拒否。
- 管理試験の問題・セット・プロファイルはすべてTXでrollback。既存default/localの設定、通常問題、過去試合は変更していない。
- `pnpm db:check`：既存権限・設定・不変版の回帰が成功。内部表11件のうちcatalog_operatorsとresult_outboxをreaderの読取対象外として検査。`pnpm db:generate`は差分なし。

### 未実施・残件

CLIからの実DB試験であり、クラウドWorker経由のE2Eではない。Worker配置・管理画面・本人ブラウザー受入は未実施。次の区切りは効果音（本文の文字送り音を含む）、ミュート、手動割当と編集手順。1D全体は未完了。


## 2026-09-16：第1段階の実装再開・ローカル検証

[実装内容・手順・残件](organization-foundation-progress.md)。ユーザーの明示指示で第1段階を再開。既存未コミット変更を保持して追加し、コミット・既存DB操作・クラウドデプロイは行っていない。

- `pnpm run check` 成功：Biome（137ファイル）、型検査、**18ファイル194テスト**、Vite設定検証、seedのDB非接続検証、Worker/clientビルド。
- 追加試験：既存actorId保持、設置者照合、組織APIのOrigin／認証／本文上限、準備中への直接アクセス拒否、対象owner・本人履歴の固定、組織内同時参加と別待機列、遅延予約の取消世代、DO再起動、異なるinstanceIdの部屋トークン拒否、部屋照合失敗時の参加保持、終端後の枠解放、開催ownerでの結果保存、候補0での待機解除と手動再参加・開始済みの継続。
- 全停止・一部停止・管理情報欠損を区別するカタログ試験を追加。欠損はQUESTION_UNAVAILABLE、確認済みの候補0はNO_RANKED_QUESTIONS。既存の非公開情報・結果再試行等の回帰も上記全体試験に含む。
- Drizzle Kitで0011〜0013とsnapshot/journalを作成。既存migrationの再適用・seed投入はしていない。
- `node scripts/check-organization-database.ts` は接続先未指定でLOCAL_TEST_DATABASE_REQUIREDとして安全に停止。型検査済み。スクリプト本体のDDL・RLS・移行照合・rollback試験は未実施。Dockerエンジンは起動完了せず、status=stopped／APIエラーだった。既存DBへの代替接続はしていない。
- 実際のReactコンポーネントに固定の検証データを渡したローカルHTTP描画で、初回設定・公開開始・担当権限のフォームが200応答に含まれることを確認。保存操作は無効な静的描画。ブラウザー操作ツールはサンドボックスrunner接続タイムアウトで起動できず、スクリーンショット・目視・クリック・キーボードの受入は未実施。
- `git diff --check` 成功。秘密ファイルの出力・コミットはしていない。

未実施：実PostgreSQLの初回設定競合、原本・outbox・固定版・レートの移行前後照合、バックアップ復元と旧DO切替、クラウド試験、画面操作、負荷試験。準備中テストは詳細のユーザー回答待ちで未実装。第1段階全体の完了判定や次段階への着手は行っていない。


## 2026-09-16：Dockerを使わない実PostgreSQLリハーサル

ユーザー指示によりDockerを検証の前提から外した。[PostgreSQL公式Windows案内](https://www.postgresql.org/download/windows/)からリンクされたEDBのZIP（17.11、Windows x64、fileid=1260491）を取得し、`.wrangler/pg-local/pgsql`へbin/lib/shareを展開した。ダウンロードしたZIPのSHA256は `4B8DB0930C38F6EF845DB919551DEDDA3B6B845AEB0927B3D79A6E8E9E4537CF`（ローカル記録値であり、配布元の署名照合ではない）。アプリの依存・Windowsサービス・PATHは変更していない。

- 専用クラスタ：`.wrangler/pg-local/data`、PostgreSQL 17.11、UTF8、locale C、SCRAM-SHA-256認証。ランダムな検証専用パスワードをGit除外済みのローカルファイルに保存し、画面には出力していない。
- 接続先：`127.0.0.1:55439/quiz_relay_organization_test`。listen_addressesを127.0.0.1に限定した。既存の.envを読み込まず、Supabase・既存データへの接続はしていない。
- 実行：`node scripts/check-organization-database.ts`、終了コード0。外側TXで0000〜0010と試験データを構築し、0011〜0016を追加適用した。
- 確認済み：本人actorId保持、設置者以外の初期化拒否、初期化の再実行拒否、追加リクエスト再送（名称変更後も含む）、古い名称・担当権限での更新拒否、準備中の閲覧制限、非管理者の公開拒否、権限取得、監査イベントの重複防止・削除拒否、識別子変更拒否、quiz_organizationによる結果表アクセス拒否。
- 保持確認：問題・固定版・設定・結果原本・参加者・outboxの移行前後ハッシュ、本人履歴・レート、新規インスタンスへの戦績混入防止、結果再送の整合性。
- 終了時：外側TXのrollbackとquiz_gameスキーマが残っていないことを検証。PostgreSQLをfast shutdownで正常停止した。再利用用のZIP・実行ファイル・停止済みクラスタはGit除外領域に保持。

直前のコード検証も完了：`pnpm run check` 成功（Biome 139ファイル、型検査、18ファイル199テスト、Vite設定・seed検証、Worker/clientビルド）。今回のDB実行に伴うアプリコード変更はない。

### 同じ専用クラスタでの再実行（PowerShell）

以下はこの作業で作成した専用クラスタだけを対象とする。パスワードや接続URLは出力しない。起動後、pg_isreadyがaccepting connectionsを返してから検証を実行する。

```powershell
Start-Process -FilePath 'H:/programing/quiz_relay/.wrangler/pg-local/pgsql/bin/pg_ctl.exe' -ArgumentList '-D H:/programing/quiz_relay/.wrangler/pg-local/data -l H:/programing/quiz_relay/.wrangler/pg-local/server.log -w start' -WindowStyle Hidden
& .wrangler/pg-local/pgsql/bin/pg_isready.exe -h 127.0.0.1 -p 55439
$pgTestPassword = [System.IO.File]::ReadAllText((Join-Path (Get-Location) '.wrangler/pg-local/password'))
$env:LOCAL_ORGANIZATION_TEST_DATABASE_URL = 'postgres://postgres:' + $pgTestPassword + '@127.0.0.1:55439/quiz_relay_organization_test'
try {
    node scripts/check-organization-database.ts
    if ($LASTEXITCODE -ne 0) { throw 'DB rehearsal failed' }
} finally {
    Remove-Item Env:LOCAL_ORGANIZATION_TEST_DATABASE_URL
    $pgTestPassword = $null
    & .wrangler/pg-local/pgsql/bin/pg_ctl.exe -D .wrangler/pg-local/data -m fast -w stop
}
```

未実施：複数接続による初期化競合、専用LOGINの実接続・TLS（今回の権限検査はSET LOCAL ROLE）、実データのバックアップ取得／復元、Supabase固有の構成差、旧DO切替、ブラウザー受入・負荷試験。試験用データのTXリハーサル成功を、既存環境移行や第1段階全体の完了とは扱わない。


## 2026-09-16：共通ログアウト・入力再試行修正、実DB競合とバックアップ復元

- ログアウトのゲームセッション失効をauth/client.tsの共通signOutへ移した。通常画面・デバッグ画面の両方に適用。失効応答を待ってからAuthを解除し、HTTP／通信失敗ではAuthを保持して再試行できる。共通関数の回帰4テストを追加。
- 組織名の検証・正規化をクライアントとサーバーで共有し、無効な名前を追加要求として永続化しない。旧実装が保存した無効名からの回復、前後空白の修正後も同じIDで再送、結果未確認の別名追加拒否の回帰6テストを追加。
- `scripts/check-organization-recovery.ts` を追加。専用localhost URLとDB名 `quiz_relay_organization_recovery` を要求し、既存quizスキーマ／ロールがあれば停止する。`.env`は読み込まず、既存DBを自動削除・上書きする機能は持たない。
- 実行環境：DockerなしのPostgreSQL 17.11、前回とは別の専用クラスタ `.wrangler/pg-recovery/data`、127.0.0.1:55440、SCRAM認証。全migrationを空の環境へ適用し、quiz_organizationのランダムパスワードを試験中だけ発行した。
- 成功：SET ROLEの代用ではなくquiz_organizationとして独立した2接続でログイン。current_userと結果表読取・identity_namespace更新の拒否を確認。
- 成功：管理接続で初回設定のadvisory lockを保持し、2接続が同じロックを待機していることをpg_locksで確認してから解放。初回設定は1件だけ成功し、もう1件はALREADY_CONFIGURED。組織・初回管理者も1件。担当権限の競合更新も1件だけ成功し、他方はEDIT_CONFLICT。
- 成功：試験用の組織・権限・監査イベントと対戦原本／参加者／outboxをpg_dumpのcustom形式へ保存。新しい `quiz_relay_organization_restored` DBへpg_restore --exit-on-errorで復元し、quiz_game／quiz_probeの全テーブルの件数・行内容hash、本人履歴／レート、管理者一覧を照合。復元先の専用LOGIN権限拒否と識別子不変トリガーも確認。
- 終了後に試験用PostgreSQLを正常停止。試験データと `.wrangler/organization-recovery.dump` はGit除外領域へ保持。既存Supabase、既存DB移行、クラウド配置には触れていない。

再実行には空の専用PostgreSQLクラスタと上記ソースDBを用意し、`LOCAL_ORGANIZATION_RECOVERY_DATABASE_URL` にその管理接続をプロセス環境変数で設定して `pnpm db:check:organization:recovery` を実行する。PostgreSQLツールは既定で `.wrangler/pg-local/pgsql/bin`、別の配置では `LOCAL_PG_BIN` を指定する。復元先DBもスクリプトが新規作成するので事前作成しない。成功・失敗後の試験データは保持するため、同じ使用済みクラスタへそのまま再実行すると安全停止する。

範囲の限界：復元先は同一の専用クラスタ内の別DBで、クラスタ共通ロールは共有している。ロール資格情報を含む全クラスタ復元、既存Supabaseの実データ、TLS／Hyperdrive、DO状態の移行、クラウドE2E、画面受入は未検証。カタログの既存データ保持は前回の単一TX試験、今回の復元は組織・対戦の試験データが対象であり、全テーブルに実運用相当データがある試験ではない。


最終確認：`pnpm run check` はBiome 143ファイル・型検査・20ファイル209テスト・設定／seed検証・ビルドが成功。その後の検証スクリプトの環境変数固定変更も、Biome・型検査と隔離DBでの競合／バックアップ復元再実行が成功した。


## 2026-09-18：常用ローカルPostgreSQLの構築

ユーザーの方針変更により、Supabase／Cloudflareの初期化を取りやめ、Supabase Authを保持して開発用DBをPC内へ分離した。[起動・停止と操作手順](local-postgres.md)。クラウドのデータ・Authユーザー・配信・DOは未変更。

- PostgreSQL 17.11、専用クラスタ `.wrangler/postgres-dev/data`、127.0.0.1:55432、DB名quiz_relay_dev。Docker・Windowsサービス登録なし。
- `pnpm db:local:setup` 成功。migration 0000〜0016を適用。2回目も成功し、データ削除やパスワードの値の再発行なし。
- `.dev.vars` の4つのアプリ用DB接続と組織有効化／localプロファイルを設定。Supabase URL・公開キー・初回管理者指定・HTTPS証明書設定の保持をプログラムで照合。以前の.dev.varsはGit除外領域へ退避。管理接続は.env.postgres-localだけに保存。
- `pnpm db:local:check` 成功。7ロールで実ログイン、reader読取・削除拒否、organizationの結果読取拒否、probe書込・読取・rollbackを確認。
- 専用DBへ一時行を保存し、stop→start後に同じ行が残ることを確認。その行を削除後、アプリ17表の合計行数0、Drizzle履歴17件を確認。問題・組織・戦績のseedは入れていない。
- 既存5173番のプロセスは保持し、5174番に検証用Viteを起動。Worker経由の `/api/probes/database` が200、committed=true、rolledBack=true、tls=local-plaintext。 `/api/auth/config` が既存Supabase URLを返すことを確認。検証用Viteは終了、DBは開発用として起動中。
- 直接DB接続の非TLSは明示的なsslmode=disableと限定したloopback名に限る。リモートホスト・紛らわしいホスト名・明示指定なしではTLSを維持する回帰7テストを追加。
- 最初の全体検証で旧APIテスト4件がローカルのORGANIZATION_ENABLED=trueを継承して失敗。旧モードを確認するfixtureへfalseを明示し、環境依存を除去した。組織モードのテストはtrueを維持。
- 最終 `pnpm run check` 成功：Biome 145ファイル、型検査、21ファイル216テスト、設定／seed検証、Worker/clientビルド。差分の空白・文書リンクも確認。

未実施：ブラウザーによるSupabaseログイン／初回管理者設定・画面受入、空DBへの任意の問題投入と対戦E2E。既存Authをそのまま使うため認証は完全オフラインではない。既存5173番サーバーは利用者が再起動して新設定を反映する。既存のクラウド向け管理CLIコマンドとローカル用資格情報の使い分けは手順書に明記した。


## 2026-09-18：動作検証画面の組織・インスタンス設定表示

- `/debug/`上部に設定確認欄を追加。組織名、閲覧可能なインスタンス名と公開／準備中状態、ログイン本人の表示名、DBで判定した管理者権限、本人識別子を表示する。管理者名はログイン本人が管理者の場合にAuth表示名（未登録ならメール）を表示。他人のAuth情報は取得しない。
- 未ログイン・組織未設定・機能無効・取得失敗を分け、「設定を再確認」と別タブの管理画面リンクを追加。Auth状態変更で旧表示を消し、古い非同期応答による上書きを防ぐ。
- 表示／取得の5テスト追加：設定名と公開状態、未ログイン時の取得抑止、Auth metadataでの管理者偽装を採用しないこと、未設定と無効の区別、失敗時に古い管理者表示を残さないこと。
- 既存の組織APIテストが実際のINITIAL_ADMIN_SUBJECTに依存していたため、fixtureにテスト用値を明示した。利用者の設定は変更していない。
- `pnpm run check` 成功：Biome 148ファイル、型検査、22ファイル221テスト、設定／seed検証、Worker/clientビルド。
- 実ブラウザーでの目視・クリック・アカウント切替は未実施。[手動確認一覧](manual-verification-checklist.md)へ追記。DB構造変更・クラウド配置はなし。

## 2026-09-18 初回設定がスキップされるローカル設定の修正

- `.dev.vars` の組織設定が重複し、末尾の無効化・空の接続先が優先される状態を確認。組織の重複を除去し、ローカル接続を復元。初回管理者指定・Supabase Auth・TLS設定を保持した。
- `local-postgres.ts setup` の設定置換を全一致へ修正。結果DBの重複設定も含めて既存ローカルDBで再実行し、`db:local:start` と `db:local:check`（7ロールの接続・権限・ロールバック）が成功。既存migrationは適用済みとしてスキップ。
- 実ローカルDBに対して本番コードの `overview` を呼び、組織機能有効・初回設定必要・指定本人の設定権限あり・インスタンス0件を確認。初回設定の登録操作は行っていない。
- 起動済みの利用者のViteは停止していない。再起動後の本人ログインとフォーム表示・登録は手動確認として残る。クラウド変更なし。
- `pnpm run check` 成功（22ファイル・221テスト、Lint・型検査・設定確認・ビルド）。

## 2026-09-18 インスタンス追加欄への初回設定値の持ち越し修正

- `OrganizationPanel` で初回インスタンス名と追加インスタンス名が同じ入力状態を共有していた。状態を分離し、初回設定直後の追加欄を空欄にする。追加成功時のクリア・失敗時の入力保持は維持。DBの名前や既存データは変更しない。
- `pnpm run check` 成功（Lint、型検査、22ファイル・221テスト、設定／seed確認、ビルド）。実ブラウザーでの初回設定からの遷移は未実施で、手動確認UI-03へ追記した。

## 2026-09-18 入力欄のプレースホルダー

- ユーザー指定をdevelopment.mdへ記録し、既存の文字・数値入力13欄へ項目別の例または入力案内を追加。チェックボックスは対象外。ラベル・検証条件・既存値は維持。
- 対象欄にplaceholderがあることをコード走査で確認。`pnpm run check` 成功（Lint・型検査・22ファイル221テスト・設定／seed確認・ビルド）。実ブラウザーでの見切れ・可読性の確認は未実施。

## 2026-09-18 担当権限設定の説明追加

- 担当権限フォームへ見出し・用途・任意設定であること・識別子の入手手順・確認と保存の違い・インスタンス単位の適用範囲・取消方法を表示。入力欄と識別子の説明をaria-describedbyで関連付けた。運営担当の設定と組織管理者の指定を区別する。
- Lint・型検査・ビルド成功。文言とアクセシビリティ属性の変更のみで、自動テストの追加・再実行と実ブラウザーの表示確認は行っていない。ユーザー一覧からの選択UIは未実装。

## 2026-09-18 実メールでの権限テストユーザー登録

- ユーザー承認の捨てメアドで新規アドレスを3件作成。各メールでSupabase Authの登録確認メールを受信し、Chromeで認証・ローカル組織へのログインを確認。Authユーザー3人の追加が今回のクラウド側変更。配置・既存データ移行・Auth設定変更は行っていない。
- 指定された「競技クイズインスタンス」にquestions／authors／usersを各1人に付与。ローカルDBへ既存のsetInstanceGrantsを通してトランザクション・管理者認可・監査記録を維持して反映した。管理画面での付与操作の受入試験ではない。
- 3人それぞれのoverviewとgrantを読み取り、指定インスタンスの1権限のみ、組織管理者false、他インスタンスのgrantなしを検証。usersアカウントで準備中の対象インスタンスが表示され、管理者向け操作が表示されないことをブラウザーで確認。作問登録・モデレーション本体の未実装機能を検証済みとは扱わない。
- アドレス・本人識別子・ログイン手順はGit除外の `.wrangler/test-users-2026-09-18.md` に保存。認証トークンや秘密値は記録しない。


## 2026-09-18：Computer Useとローカル実通信検証

対象は実装済みの組織・インスタンス基盤。Chrome拡張経由のComputer Use、稼働中のVite/ローカルWorker、Windows PostgreSQL 17.11（`quiz_relay_dev`）と既存Supabase Authを使用。未コミット変更を保持。既存クラウドDBへのmigration・クラウドデプロイは行っていない。

### 発見・修正

同じactorの`logoutActor`が重なると、先行要求の完了が`loggingOut`を消し、後続の失効処理中に再参加を受け付ける不具合を回帰試験で再現した（修正前は`LOGOUT_PENDING`を期待した箇所で参加成功）。actor単位でlogout要求を直列化し、最後の要求が完了するまで参加を止める。異なる要求に含まれるCookie由来の部屋も順番に処理する。RPC失敗時の永続フラグと再試行経路を維持した。

`tests/matchmaking.test.ts`へ追加：重複logout、RPC失敗→DO eviction→再試行→旧token拒否、100問・各テキスト項目の最大長での定義保存／再起動復帰、1024アカウント上限の拒否／期限後復旧。最大定義を待機列本体へ複製しないこと（queueのJSON表現4096 bytes未満）も確認した。これは長期・多インスタンス負荷測定全体の代替ではない。

### 実ブラウザー

- Googleログインで管理者の既存組織へ復帰。`/debug/` の本人名・組織名・管理者名・3インスタンスの状態を照合。
- 追加名が空白だけの場合、エラーと入力保持。前後空白付きの追加で正規化され、成功後に追加欄が空欄へ戻る。
- 検証専用インスタンスを追加。2タブの改名で、古い側は競合エラー、新しい変更は保持。一覧の再読込でフォームも最新名へ復帰。
- 作問管理テストユーザーの権限を取得し、作問管理だけチェックされていることを確認（既存権限は変更せず）。
- 検証専用の公開開始、設定未登録の案内、空のランキング／本人履歴を確認。不正なinstance指定では利用不可の案内。
- 検証用12問と2人用設定を専用ownerへ投入。実WebSocketの1人待機、別タブ閲覧時の維持、待機取消を確認。
- 専用12問を一時停止し、候補0の案内とAlarmによる待機解除を確認。12問を復元し、同じ画面から再参加・接続成功。復旧時にページ全体のリロードは不要。
- 通常幅943pxの設定・組織画面と、内容幅360pxの対戦フォームを確認。確認した対戦画面はscrollWidthとclientWidthが一致し、横はみ出しなし。全ページ・全ブラウザーのUI受入とは区別する。

### 認証付きの実対戦・DB保存

作成済みの作問管理／作問者資格管理テストユーザー2人に、既存Supabase Authで独立した試験セッションを発行。ブラウザーの管理者セッションとは別のHTTP/WebSocketクライアントで、ローカルWorkerへ接続した。APIキー・認証トークンはメモリ内だけで扱い、証跡へ出力していない。試験終了時にゲームlogoutと試験Authセッションのlocal signOutを実行した。これは2つの実ブラウザープロファイルを並べた操作検証ではない。

- 両アカウントが非管理者で、対象外の準備中インスタンスを一覧へ含めず、直接アクセスも拒否。
- 同一部屋で2人接続→通常問題への解答→7問正解で`target_reached`終了。
- 保存状態`confirmed`と、双方の本人履歴に同じ結果が存在することを確認。
- 結果ID：`22e5b7da-0e7e-49f6-a9e4-349b89513e4f`。実ブラウザーの管理者からランキング1020／980を確認し、管理者本人の履歴には混入しない。
- 試験先：`08885bff-4c6f-46d4-ae1d-c47ef767795c`（検証専用 20260918 更新）。既存2インスタンスの状態・問題・権限を変更していない。

認証試験は[SupabaseのOTP検証](https://supabase.com/docs/reference/javascript/auth-verifyotp)の既存SDKを使用した。テストアカウントのパスワード変更・新規アカウント作成は行っていない。

### CLI障害・基盤疎通

追加インスタンスのカタログ用ロール発行、同一ファイルでの再実行、対象外ownerの`CATALOG_FORBIDDEN`を実DBで確認した。別の一時fixtureでは、資格情報ファイルの書込直後・DB commit前に例外を注入。ロールとowner対応がrollbackされ、ファイルは保持されること、再実行で上書きしないことを確認した。

ファイルだけ残った状態では、対象・owner・ロール不存在を照合し、保存済み資格情報と同じパスワードでロール／対応をtransaction内で復旧。その後CLIで接続確認できた。ロールだけ残った状態では新しい資格情報を発行せず失敗し、保管した元ファイルを戻すことで復旧した。試験用の一時インスタンス・ロール・資格情報ファイルは除去。実運用でロールやファイルを無条件に削除・再発行する手順ではない。

ローカル実サーバーへの既存`probe.mjs`でhealth、DO保存、Alarm、署名、DB commit/rollbackが全てPASS。Nodeの通常CAだけでは開発用自己署名証明書を認識しなかったため、Vite設定の公開証明書を`NODE_EXTRA_CA_CERTS`へ指定した。TLS検証を無効化していない。

実行資料とバックアップはGit除外の`.wrangler/qa-20260918/`へ保存：操作前`before-browser-debug.dump`、`catalog-failure-check.mjs`、`live-e2e.mjs`、検証用出題設定。スクリプトは今回の専用ローカルfixtureに結び付いた実測資料であり、汎用のCI／移行コマンドではない。秘密値の実体は既存の除外済みenvファイルから読む。

最新の確認範囲・未実測項目は[手動確認チェックリスト](manual-verification-checklist.md)を参照。ユーザーへの依頼はUIの分かりやすさに限定するが、未回答仕様・移行前試験・長期運用試験を完了扱いにはしない。


追記：待機中に別タブの`/debug/`からログアウトし、試合タブがログイン画面へ戻ること、debug上の管理者名・組織情報が消えることを確認。単独操作の結果表示は`signedOut: true`。その後Googleで管理者へ再ログインした。通常の対戦画面・組織画面も同じ共通signOutを使うが、全画面×全試合状態の実ブラウザー操作組合せは未実施。

最終検証：`pnpm run check`成功。Biome 148ファイル、型検査、22ファイル225テスト、Vite設定・seed preview検証、ビルドが全て成功。`git diff --check`も成功（既存の改行コード警告のみ）。


## 2026-09-22：権限説明の短縮と競技クイズ用ダミー問題

- 権限設定の常時表示を「このインスタンスの運営権限を付与します。組織管理者への設定は不要です。」「相手の識別子を貼り付け → 確認 → 役割を選んで保存。」へ短縮。識別子の取得方法は「識別子はどこ？」を開くと表示。確認と保存の操作は分離したまま、ボタン名・取消説明も短縮した。
- ユーザー指定の「競技クイズインスタンス」（`d6fa88f3-9f13-4d57-a761-256baba8c656`）は、作業開始時点で公開中・問題0件・出題設定なしだった。ローカルDB `quiz_relay_dev` に限定し、既存seedのダミー12問とlocalプロファイルの2人用設定を追加。公開状態、担当権限、他インスタンスは変更していない。
- 接続先がlocalhostの対象DBであることを検証したうえで既存seed／設定CLIを使用。reader権限の`loadMatchDefinition`で12問・2人設定を取得できた。保存した投入設定はGit除外の`.wrangler/qa-20260922/competitive-matchmaking.json`。
- 変更ファイルのBiome検査・型検査成功。今回の競技クイズインスタンスでの実対戦完走は未実施。クラウドDB変更・migration・デプロイなし。


## 2026-09-22：権限設定の説明を1文へ、待機ボタンの余白修正

ユーザーから現行の権限設定機能は将来廃止予定との指示。画面説明は指定の「このインスタンスの運営権限を付与します。組織管理者への設定は不要です。」だけにした。操作手順・折りたたみ案内・取消説明を削除し、入力ラベル・入力例・対象確認・保存・エラー表示は維持。削除した説明へのaria-describedby参照も除去した。機能自体の廃止は今回実施していない。

待機取消ボタンに右余白を設け、隣のログアウトボタンとの接触を解消。DB・対戦処理・権限処理は変更していない。

## 2026-09-22：サイドバーと同一タブのナビゲーション

- PCのサイドバー、スマートフォンの標準dialog、インスタンス切替、履歴・設定・開発ツールへの同一タブ移動を実装。未実装の作問・ユーザー管理メニューは表示しない。
- `pnpm run check`：23ファイル226テスト、Lint、型検査、設定検査、seedプレビュー、ビルド成功。UI確認後の余白調整も型検査・対象テスト・ビルドで確認。
- Chrome＋ローカルWorker／PostgreSQL、既存管理者で検証。競技クイズインスタンスで1人待機し、履歴→別インスタンス→接続確認→対戦への復帰で同じ参加者の接続済み・待機状態を確認。別インスタンスを見ても復帰バーは競技クイズを示し、二重参加フォームは出さない。最後に検証用の待機を取り消した。
- PC幅1280pxとスマホ幅390pxで配置を確認。スマホの横はみ出しなし、選択後・同じ項目選択後に閉じる、Escapeで閉じて開くボタンへフォーカス復帰、ブラウザーの戻る、選択中インスタンスだけの設定画面、コンソールエラーなしを確認。検証用の画面幅を解除済み。
- 今回は1人の待機を使った接続維持を検証した。出題進行中の2人試合での切替、Safari／実機スマホは未実施。配色・寸法・メニューの分かりやすさはユーザーが初版を触って調整する。既存DB移行・クラウドデプロイは実施しない。

## 2026-09-22：メニューの操作・見た目の調整

三本線↔Xの専用ボタンと180msのスライド、ロゴの横並び、枠と矢印付きアコーディオン、白背景＋左線の選択表示を実装。インスタンス切替時はdialogと一覧を保持し、通常のページ選択時は閉じる。動きを減らす設定を尊重する。Chromeのスマホ幅で切替後のdialog・一覧保持、選択表示、横はみ出しなしを確認。

追加確認：通常ページ選択・X・Escapeで閉じること、ページ見出し／開くボタンへのフォーカス復帰、PC幅1280pxの表示を確認。Lint・型検査・ナビゲーション回帰2件・ビルド成功。全体テストは前回実施分で、今回の対象テストとは区別する。画面幅の上書きは解除した。

### 同日追加：一覧リンク・外枠・アカウント余白

インスタンス一覧リンクを切替アコーディオンの外へ移動し、アコーディオンの外枠と子項目の補助線を削除。名前／メールアドレスとアカウント項目の間に12pxの余白を追加。Chromeでリンクがdetails外にあること、全アコーディオンのborderが0px、アカウントの間隔12pxを確認。Biome・型検査・ビルド成功。ネットネタはローカルDBにpreparingで残り、管理者の一覧にも表示されることを確認。準備中を一般アカウントに返さない既存認可は変更しない。

### 同日追加：インスタンス候補・アカウントのポップアップ

標準Popover APIで候補を重ねて表示し、アカウントは上向きに開く。画面端では表示可能な側に配置し、画面幅内に収める。インスタンス選択時は候補とスマホメニューを維持し、通常遷移・メニュー終了時はポップアップを閉じる。開発ツールは常時表示。現在地の赤線を削除し、サイドバーの文字をロゴ以外16pxに統一。キーボードフォーカスはサイドバー内では墨色で維持する。

Chromeのスマホ幅390px・PC幅1280pxで候補の重なり、切替後の保持、アカウントの上向き表示（ボタンから8px上）、Escapeでポップアップだけを閉じる動作を確認。横はみ出しなし、PCで対象文字が16px・現在地borderが0pxをDOMでも確認。画面幅を解除済み。型検査・対象回帰2件・ビルド成功。ビルドには既存単一JSが500kBを超えたサイズ警告があるが生成は成功。

### 同日追加：管理メニューの表示権限・固定スクロール

組織管理を常時表示にし、開発ツールを含め管理者のみへ限定。開発ページの直接URLにもクライアント側の管理者確認を追加（サーバー認可は従来どおり）。ナビゲーションの実コンポーネントをSSRで描画する回帰テストで、一般ユーザーには組織管理・開発ツールがなく、管理者には表示されることを確認。対象の遷移テストと合わせて3件成功。

PC 1280×600でサイドバー288×600、アカウントボタンは内幅287px全体、低コントラストの細いスクロールバーを確認。実ホイール操作で内部scrollTopが0→317となり本文は0のまま。下端の追いスクロールでも本文へ流れず、アカウント上の上スクロールで内部だけ317→217へ移動。スマホ390×700でも320px幅・700px高固定、ボタン幅319px、横はみ出しなし。画面幅の上書きは解除する。

### 同日追加：スクロールバーの右端配置・固定ユーザー欄

スクロール領域をサイドバー右端まで広げ、外側の余白を削除。Chromiumでは幅6pxのバーと上下ボタン非表示を適用し、標準スクロールバーのブラウザー向けに細幅・低コントラストの指定も残す。固定ユーザー欄とアカウントボタンは共通の濃い背景で区別する。

ChromeのPC 1280×600でサイドバー右端288pxに対しスクロール領域右端287px（境界線1pxだけ）、バー幅6px、上下ボタンdisplay:none・幅高さ0pxを確認。スクリーンショットで右端配置・矢印なし・固定欄の背景差を確認。Biome・型検査・ビルド成功。既存のJSサイズ警告は継続。画面サイズの上書きを解除済み。

### 同日追加：ユーザー欄の配色・アカウントボタン

ユーザー指定に合わせ、固定欄を白背景、アカウントを共通Buttonの枠線・下影付きに変更。左右20pxの内側いっぱいに配置。スクロールバーの外側へ4pxの余白を追加。Chromeで白背景、右端の間隔5px（余白4px＋境界線1px）、ボタン枠1px・下影3px、クリックでアカウントポップアップが開くことを確認。Biome・型検査・ビルド成功（既存のJSサイズ警告のみ）。

## 2026-09-22：コミット前レビューと自動検証

- 未コミットの組織・インスタンス基盤、認可、結果保存、ローカルDB、共通ナビゲーションをレビュー。初回管理者の指定、公開前インスタンスの可視性、開催元ごとの結果読取、サーバーでのインスタンス確認、移行SQLの権限・制約、秘密ファイルの除外を重点確認した。
- 修正1件：local-postgres.tsのreader削除権限試験をトランザクション内へ移した。誤った権限設定でDELETEが成功しても必ず例外でロールバックし、検証失敗を返す。検証自体によるデータ損失を防ぐ。
- pnpm run check成功：Biome 160ファイル、型検査、24ファイル228テスト、設定検査、seedプレビュー、ビルド。上記スクリプト修正後もBiome・型検査成功。pnpm run db:local:checkで7種類のローカル接続・書込ロールバック・権限境界を確認。
- Computer Use／Chrome：スマホ390×700でインスタンス切替後のメニュー・候補保持、横はみ出しなし、アカウント矢印なし・上向きポップアップ、Escapeで候補のみ閉じる、通常ページ選択でメニューを閉じ見出しへフォーカス復帰を確認。
- PC1280×600で競技クイズの1人待機→履歴→別インスタンス閲覧→対戦復帰を操作し、接続済みの待機が維持されることを確認。待機取消完了。スクロール下端で本文位置411pxは変わらず、固定アカウント上の上スクロールではサイドバーのみ315→215pxへ移動。確認時のブラウザーエラーログなし。画面サイズの上書きは解除済み。
- 今回確認した範囲にコミットを止める問題は残っていない。既存のJS単一チャンク約501kBの警告は残る。今回2人の実対戦完走・実機Safari・クラウド環境の確認は再実施していない。第1段階全体の完了・移行承認を意味せず、既存DB移行とクラウド配置は別途確認する。