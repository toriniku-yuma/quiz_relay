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
