# 0A・0Bの実行手順

状態：2026-09-10、0A完了、0Bは承認workers.dev限定の技術基盤として完了判定。以下の準備手順・過去の追記には当時の未実施記述を含む。最新判定は末尾と検証記録を優先する。実行結果は[検証記録](verification-results.md)を参照。詳細契約は各連合実装の着手前へ移動した。ゲーム、正式参加セッション、連合inboxはまだ実装していない。

## ローカルで動かす

Node 26.8.1 / pnpm 10.28.2を今回の検証版として固定した。`.node-version` と `pnpm-lock.yaml` を使う。Nodeの導入・切り替え方法は利用環境に合わせる。

```powershell
pnpm install --frozen-lockfile
Copy-Item .dev.vars.example .dev.vars
```

既に `.dev.vars` がある場合はコピーで上書きしない。`PROBE_TOKEN` に暗号学的乱数32バイト以上の値を設定する。今回の作業環境では生成済みで、Git管理外の `.dev.vars` に保存している。トークンや接続文字列をチャット・スクリーンショット・Gitへ載せない。

```powershell
pnpm run check
pnpm run dev
```

`pnpm run dev` は今回の開発PCのTailscale IP（100.102.202.80:5173）で起動する。設定済みの自己署名HTTPSを使い、`https://desktop-149oae5.taildd84bf.ts.net:5173/` を開く。疎通確認はトークン不要。他の検証は `.dev.vars` のトークンを画面へ入力する。画面のトークンはReactのメモリ内にだけ置き、再読込・遷移で消える。

- 「DOに保存・5秒後にAlarm」でカウンターが増える。5秒以上たって「DO状態を取得」するとdeadlineがnull、firedAtに処理時刻が入る。
- 開発サーバーを停止・再起動して「DO状態を取得」し、値が維持されることを確認する。ローカルの `.wrangler` は保存データを含むため、通常の再起動で削除しない。
- 「署名を検証」でWorkers内のEd25519/JCS検証を行う。検証用鍵は毎回生成し、秘密鍵を保存・返却しない。
- DB・Authは未設定なら未設定と表示する。失敗を成功扱いにはしない。

別ターミナルの `pnpm run probe` は実際のHTTP経路で疎通、保存、5秒Alarm、Workers署名のNode検証を行う。DATABASE_URLがあればDBのcommit/rollbackも実施し、なければNOT_CONFIGUREDを出す。メール送信やOAuthは実行しない。

## 外部サービスの準備

最初に必要なのはCloudflareアカウントと、既存本番データを含まないSupabase開発用プロジェクト1つ。準備状況と利用可能な予算を確認してから実環境へ配置する。独自ドメインの購入は現段階の必須条件にせず、利用可能なHTTPS originを確認する。Bの独立DB/Authは2Aで準備するが、0Bのブラウザー間受け渡し検証用には別originも必要になる。

| 準備 | 用途・設定先 |
| --- | --- |
| Cloudflare利用権限 | 専用Worker `quiz-relay-probe` と検証DO。既存の同名Workerがある場合は別名に変更する。Wranglerの認証はユーザーの端末で行う |
| Supabase開発用プロジェクト | Transaction pooler、DBロール、Authの検証。URL・publishable keyは設定へ、DB接続文字列は `.dev.vars` / Worker secretへ |
| 検証HTTPS origin | AuthのSite URLと許可redirect URLへ登録。ローカル確認用には `http://127.0.0.1:5173/` も登録する |
| Google OAuth設定 | Googleログイン検証時にGoogle Cloud側のOAuthクライアントとSupabaseのGoogle providerを設定する。詳細はプロジェクト準備後に案内する |
| メールの検証先 | Supabaseのメール設定で送信可能な本人のアドレス。メール送信は画面でユーザーが操作する |

秘密情報の提出は不要。準備状況・対象プロジェクト・利用範囲を確認した後、秘密を設定する具体的な操作を案内する。

## DB検証の準備と実施

1. 専用の開発用DBへ `supabase/migrations/202609080001_probe.sql` をmigration管理者で一度適用する。検証専用schema/tableと最小権限の `quiz_probe` ロールを作る。ゲーム本体のschemaはまだ作らない。
2. 管理者のpsqlセッションで `\password quiz_probe` を使い、ロールのパスワードを対話入力する。パスワードをSQLファイルやコマンド引数へ書かない。psql未導入の場合は環境に合わせた手順を別途用意する。
3. SupabaseのConnect画面のTransaction pooler接続先を使い、ユーザー部分を `quiz_probe.<project-ref>` として `.dev.vars` のDATABASE_URLへ保存する。実際のhost・portを画面で確認する。
4. Workerを再起動して「DBのcommit・rollback」または `pnpm run probe` を実行する。検証用UUID行でTX内の読取、commit後の存在、rollback後の不存在を確認し、finallyで対象行を削除する。
5. さらにanon/authenticatedで検証schemaへアクセスできないこと、通常ロールでDDLできないことを実DBで確認する。通信断時に検証行が残った場合は専用schemaを管理者が確認する。

接続はPostgres.js、`prepare: false`、`ssl: 'verify-full'`、接続数1、接続タイムアウト10秒。TLS検証を無効化して通すことはしない。2026-09-09にNodeとローカルWorkerから実Supavisorへ接続し、commit/rollback、権限制御、検証行の後始末を確認した。Cloudflare配置後の接続は未検証。

## 認証遷移の検証

SUPABASE_URLとSUPABASE_PUBLISHABLE_KEYを設定して再起動する。画面のログインボタンはSDKのPKCEを使い、公開設定・PKCE verifier・認証状態をlocalStorageへ保存する。メールリンクは同じブラウザー・同じoriginなら別タブでも開ける。別端末・別ブラウザー・メールアプリ内ブラウザーには引き継げない。ブラウザー終了後も認証状態は残るため検証後はログアウトする。変更前に送信したリンクは新しい保存先にverifierがないため、更新後にログインを開始し直す。これは検証画面用で、正式な開催元セッションとは別。

メールとGoogleのそれぞれで、ログイン→元の画面へ戻る→自動の本人確認結果→ログアウトを試す。「本人確認」ボタンで手動の再確認もできる。「本人確認」は `getUser()` によるAuthサーバー確認で、トークンやメールを結果欄に出さない。redirect先の不一致、codeの再利用、別ブラウザーでのPKCE失敗も確認する。同一ブラウザーの別タブは成功対象。2026-09-08にユーザーが実メールリンクから本人確認成功を確認した。実環境のログアウト後の未認証確認と新しいメールでの再ログインもユーザー確認済み。メール認証の一連の検証は完了し、Google OAuthは未確認。

## クラウドでの実行

### 設定済みWorkersへのデプロイ

実行するのはユーザーの明示指示がある場合、または検証にサーバー実環境が必要な場合のみ。デザイン確認は原則 `pnpm dev` を使う。[デプロイの判断基準](development.md#デプロイの判断基準2026-09-11)を参照。

今回の開発PCではCloudflareへのログイン、WorkerのSecret、Hyperdriveの設定は済んでいる。プロジェクトのフォルダーで次を実行する。

```powershell
cd H:\programing\quiz_relay
pnpm run deploy
```

ビルド後に既存のquiz-relay-probeへ配置する。公開先は https://quiz-relay-probe.quiz-relay.workers.dev/ 。通常のデプロイでは検証APIは無効（PROBES_ENABLED=false）になる。

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

検証終了後は無効に戻す。ビルド済みの同じ内容を再配置する場合、再ビルドは不要。

```powershell
pnpm exec wrangler deploy --var PROBES_ENABLED:false
```

検証APIは常設の管理APIとして流用しない。別アカウントへ新規配置する場合は、この手順だけでは準備が完了しない。末尾の「Cloudflare実環境のDB経路」に従い、そのアカウントのHyperdrive・CA・Secret・Authのredirect設定を準備する。

WebSocket検証経路 `/api/probes/socket` はAuthorizationヘッダーが必要なCLI/テスト用。ブラウザーWebSocket APIは任意ヘッダーを設定できないため、この画面にWebSocket接続ボタンは設けていない。トークンをURLへ入れる回避策は使わない。

## 0Bで決めた範囲と残件

[ADR 0006](adr/0006-phase-zero-foundation.md)にローカルで検証した技術選択と限界を記録した。署名のアルゴリズム・正規化・期限・宛先・用途・nonce検査の検証用実装はあるが、永続nonce消費、参加チケット交換、権限を含む本番メッセージschemaは未実装。

当初の送信先コードはRequest構築だけだった。2026-09-10に末尾の限定プロファイルと固定宛先の送信検証を追加した。手動承認origin・固定path・HTTPS・IP表記拒否と、`redirect: manual` / 3xx拒否を確認した。公開hostが内部IPへ解決される場合やDNS rebindingへの対策はこれだけでは成立しない。一般ドメイン向けの実送信は、DNSを含む経路検証まで有効化しない。現在の固定宛先検証は本番配送ではない。

Q11のブラウザー間受け渡し、Q12の大会所有者・認定、Q13の取消・訂正、Q14の利用許諾・停止伝達は既存案を維持し、未確定を確定済みに変えていない。外部サービス準備後に検証し、採用した契約・値だけをprotocol/schema/securityへ反映する。旧計画ではこれらも0Bの完了条件だったが、2026-09-10の範囲整理で各連合実装の着手前へ移動した。未実施のまま完了したとは扱わない。

## Tailscaleからの接続（2026-09-08追加）

ユーザー指定により、Vite自身の自己署名HTTPSをTailscale経由で利用する。ServeやOSへのCA登録は使用していない。証明書は30日有効で、今回の期限は2026-10-08 UTC。

- 起動：`pnpm run dev`（Tailscaleへの接続が必要）
- 接続先：`https://desktop-149oae5.taildd84bf.ts.net:5173/`
- `.dev.vars`：PROBE_ORIGINを上記の末尾スラッシュなしのoriginへ設定。DEV_TLS_CERTとDEV_TLS_KEYには `.wrangler/tls/dev-cert.pem` と `.wrangler/tls/dev-key.pem` を指定する。どちらもGit管理外。
- 初回は自己署名の警告から「詳細設定」→対象サイトへ続行する。Edgeで実際に続行し、secure contextとWebCrypto/SHA-256の動作を確認した。全ブラウザーでの成功を保証したものではない。
- SupabaseのAuthentication → URL Configuration → Redirect URLsに上記のHTTPS URLを追加し、このURLからメールログインを開始する。
- 同じPCでもIP形式のOriginは今回のSupabase OTP preflightがHTTPSでも403だった。Tailscale DNS名では200だったため、ログイン検証にはDNS名を使用する。DNS名は同じ100.102.202.80へ解決する。

証明書はOpenSSLのreq -x509で生成し、SANに100.102.202.80、127.0.0.1、localhost、上記Tailscale DNS名を含める。期限切れやIP/DNS名変更時には再生成する。Viteのserver.httpsへ証明書と鍵を渡し、外部のTLS終端サーバーは追加しない。

CLIで自己署名HTTPSを検証する場合は、コマンド用のPowerShellで `$env:NODE_EXTRA_CA_CERTS = (Resolve-Path .wrangler/tls/dev-cert.pem).Path` を設定してから `pnpm run probe` を実行する。TLSの検証全体を無効にせず、今回の証明書をそのプロセスで信頼する。

以下のServe手順はHTTPSが必要になった場合の任意の代替手段として残す。

1. `.dev.vars` の `PROBE_ORIGIN` に自PCのTailscale HTTPS originを指定する（末尾スラッシュなし）。ViteのallowedHostsと検証APIの許可Originに使用する。転送ヘッダーは信頼せず、指定したOriginだけを追加で認める。
2. 代替のServe構成ではDEV_TLS_CERT / DEV_TLS_KEYを外し、`pnpm run dev --host 127.0.0.1` を起動する。待受は127.0.0.1:5173を維持し、ポート使用中なら別ポートへ自動変更せず停止する。
3. `tailscale serve --bg http://127.0.0.1:5173` を実行する。Serveが無効ならCLIが示す管理URLで有効化する。これはTailscale内向けServeで、Funnelではない。
4. `tailscale serve status` に表示されたHTTPS URLを開く。SupabaseのAuthentication → URL Configuration → Redirect URLsにもそのURL（末尾 `/` 付き）を追加する。
5. メールログインはこのHTTPS URLから開始し、同じブラウザーの同じoriginへ戻る（別タブ可）。localhostから開始したログインをTailscale側へ引き継がない。
6. 終了時は今回のHTTPS転送を `tailscale serve --https=443 off` で解除できる。既存の別サービスがある場合は対象を確認してから解除する。

`pnpm run probe` もPROBE_ORIGINのURLを使う。ローカルだけ検証したい場合は、そのコマンドに渡すPROBE_ORIGINを `http://127.0.0.1:5173` にする。

Cloudflare Vite pluginはローカルpreview用にWorker側のdistへ.dev.varsを生成することがある。distを公開ディレクトリとして丸ごと配らず、設定したclient assetsを使う。開発サーバーでは元の.dev.varsとdist側の.dev.varsが403になることを確認した。

### メール送信が429になる場合

Supabase側の認証回数制限。連続再送を止め、Authentication → Rate Limitsで設定を確認する。同じユーザーへの再送間隔とプロジェクト全体の上限があり、429だけでは該当する制限や解除時刻を断定できない。画面のstatus/codeも確認する。[公式の制限一覧](https://supabase.com/docs/guides/auth/rate-limits)参照。
### DBのCA証明書（2026-09-09）

SupabaseのDatabase Settings → SSL ConfigurationからCA証明書を取得し、.wrangler/supabase-ca.crtへ保存する。今回取得した元のファイル名はprod-ca-2021.crt。設定済みの.dev.varsには、DATABASE_CA_CERTにPEMを改行エスケープした文字列、NODE_EXTRA_CA_CERTSに上記ファイルパスを保存した。pnpm devはNodeの--env-file-if-existsで.dev.varsを起動時に読み込み、Miniflareの外向きTLSにもCAを追加する。起動後の環境変数変更では反映されないためサーバーを再起動する。

Postgres.jsのworkerd用TLS実装はcaオプションを渡さず、Workersランタイムの信頼CAを使う。DATABASE_CA_CERTはNode側の検証に使い、ローカルWorkerにはNODE_EXTRA_CA_CERTSで渡す。クラウド側の信頼CA・接続方法は配置時に別途確認し、ローカル成功だけで互換性確定とはしない。

psql未導入の今回の環境では、Git管理外の.env.db-adminに一時管理者URLとパスワードを入力し、既存Postgres.jsでquiz_probeのパスワードを設定した。乱数パスワードからSCRAM verifierを生成してALTER ROLEへ渡し、平文パスワードをSQLへ含めていない。接続確認後は検証専用DATABASE_URLを.dev.varsへ保存し、一時管理者ファイルを削除した。管理者設定はWorkerへ渡していない。
### Cloudflare実環境のDB経路（2026-09-09）

公開検証先は https://quiz-relay-probe.quiz-relay.workers.dev 。Workers Free / Hyperdrive Freeを使用。クラウドからのDB直接接続は500で失敗したため、証明書検証対応のHyperdrive経由を採用した。HyperdriveはSupavisorのsession port 5432へ接続し、Supabase CAでverify-full、キャッシュ無効、接続上限5。ローカルのTransaction pooler 6543への直接接続は維持する。

vite.config.tsのbuild時設定がHYPERDRIVE bindingを配置用Wrangler設定へ追加するため、配置は必ずpnpm run buildの後に行う。通常のpnpm deployではPROBES_ENABLED=false。検証時だけpnpm exec wrangler deploy --var PROBES_ENABLED:trueで有効化し、終了後はfalseへ戻す。クラウドの検証はnode --env-file=.wrangler/.env.cloud-probe scripts/probe.mjsで行う。専用トークンはローカル用と分離してGit管理外に保存している。

WorkerのSecretはPROBE_TOKEN、SUPABASE_URL、SUPABASE_PUBLISHABLE_KEY。DB資格情報とCA検証設定はHyperdrive側にある。クラウドのDATABASE_URLとDATABASE_CA_CERT Secretは削除済み。ローカルの.dev.varsは従来どおり保持する。別アカウントへ配置する場合は、そのアカウントでHyperdrive/CAを作成してvite.config.tsのIDを変更する。

[Hyperdrive無料枠](https://developers.cloudflare.com/hyperdrive/platform/pricing/)は1日100,000クエリで、無料枠超過時はエラー。今回の検証は少数のリクエストのみで、有料プランへは変更していない。
## 2026-09-10：現在の確認範囲と送信検証

0AのクラウドDB・DO復帰・Authと採用方式は検証記録に記載済み。0Bは署名と限定送信経路の技術基盤で区切る。一般のDNS rebinding、独立A/B参加、永続nonce、本番の大会・問題・結果契約は未実装・未検証で、verification.mdの後続ゲートへ引き継ぐ。

初期の送信先は手動承認した https://worker.account.workers.dev の完全一致のみ。独自ドメイン、IP、別ポート、プレビュー等の余分なラベルは拒否する。global_fetch_strictly_publicで公開経路を使い、固定path、redirect: manualと3xx拒否を併用する。peer管理APIや汎用送信APIは公開していない。

検証時はビルド・PROBES_ENABLED:trueでの配置後、次を実行する。

```powershell
node --env-file=.wrangler/.env.cloud-probe scripts/probe-egress.mjs
```

これは固定した自Workerの未実装inboxへ公開のダミー本文だけをPOSTし、JSON 404を確認する疎通試験。独立A/Bの配送成功ではない。任意の宛先や受信認証ヘッダーを転送しない。終了後はPROBES_ENABLED:falseで再配置する。

Google認証にはSupabase Redirect URLsの https://quiz-relay-probe.quiz-relay.workers.dev/ とGoogle OAuthのJavaScript生成元の同originを登録済み。Supabase callback URIを維持する。クラウド操作時は.wrangler/.env.cloud-probeの専用トークンを使用する。

## ページとコード整形（2026-09-10）

- 動作検証：https://quiz-relay-probe.quiz-relay.workers.dev/debug/
- 配色・ボタン比較：https://quiz-relay-probe.quiz-relay.workers.dev/design/
- ローカルもpnpm run devで起動し、同じ/debug/・/design/を使用する。
- トップ/は/debug/へリダイレクトする。認証の戻り先として登録済みの/を維持し、code/query/hashをデバッグ画面へ引き継ぐ。Google/Supabaseの追加設定は不要。
- pnpm run formatで整形、pnpm run checkで整形・型・テスト・ビルドを確認する。

比較候補は紙と墨・深緑・青・夜の4配色と、段差付き・輪郭線・フラットの3ボタン。ページ内の選択はプレビューのみを変更し、採用設定にはしない。配色名とボタンA/B/Cを指定して調整できる。

コード整形はBiomeへ移行済み。pnpm run formatで整形、pnpm run lintで整形・推奨Lint・import整理を確認、pnpm run checkで型検査・テスト・ビルドまで実行する。

配色比較を更新：現在の/design/は参考元リンク付きの白×赤・黄×黒・グレー×緑の3案。段差付きボタンを共通にして配色を比較する。


## 2026-09-11：ベースデザインを適用

採用したColor Huntの赤白配色をTailwindの共通定義（src/client/styles/global.cssの@theme）へ反映。背景・通常キー #F5EDED、面・主操作上の文字 #FFFFFF、主操作 #D72323、本文・補助文字・ボタンの段差 #3E3636、強調 #000000、境界線 #8A8A8Aを使う。共通Buttonは段差付きに統一。比較専用の配色データ・部品・CSSと/design/ページ・リンクを削除した。上記の見本ページ案内は過去の記録であり、現行では使わない。確認はローカルで行い、Workersへの反映は別途デプロイ条件を満たす場合のみ実施する。
