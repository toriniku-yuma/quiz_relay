# 開発環境・接続確認

[ドキュメント一覧](../README.md)

初めて起動するときに使います。通常のゲームDBはPC内PostgreSQL、ログインはSupabase Authです。

現在のゲームDBはPC内PostgreSQLです。対戦・結果保存・組織基盤は実装済み、組織間の参加・配送は未実装です。

<a id="phase-0-002"></a>
## ローカルで動かす

Node 26.8.1 / pnpm 10.28.2を使用します。`.node-version` と `pnpm-lock.yaml` を使う。Nodeの導入・切り替え方法は利用環境に合わせる。

```powershell
pnpm install --frozen-lockfile
if (-not (Test-Path .dev.vars)) { Copy-Item .dev.vars.example .dev.vars }
```

既に `.dev.vars` がある場合はコピーで上書きしない。`PROBE_TOKEN` に暗号学的乱数32バイト以上の値を設定する。今回の作業環境では生成済みで、Git管理外の `.dev.vars` に保存している。

トークンや接続文字列をチャット・スクリーンショット・Gitへ載せない。

```powershell
pnpm db:local:start
pnpm run dev
```

初回は[ローカルDB手順](local-postgres.md)でDB・初期管理者を準備します。`pnpm run check` は整形・型・テスト・ビルドの確認です。

`pnpm run dev` はこの開発PCのTailscale IP（100.102.202.80:5173）で起動する。

設定済みの自己署名HTTPSを使い、`https://desktop-149oae5.taildd84bf.ts.net:5173/` を開く。疎通確認はトークン不要。

他の検証は `.dev.vars` のトークンを画面へ入力する。画面のトークンはReactのメモリ内にだけ置き、再読込・遷移で消える。

- 「DOに保存・5秒後にAlarm」でカウンターが増える。5秒以上たって「DO状態を取得」するとdeadlineがnull、firedAtに処理時刻が入る。
- 開発サーバーを停止・再起動して「DO状態を取得」し、値が維持されることを確認する。ローカルの `.wrangler` は保存データを含むため、通常の再起動で削除しない。
- 「署名を検証」でWorkers内のEd25519/JCS検証を行う。検証用鍵は毎回生成し、秘密鍵を保存・返却しない。
- DB・Authは未設定なら未設定と表示する。失敗を成功扱いにはしない。

別ターミナルの `pnpm run probe` は実際のHTTP経路で疎通、保存、5秒Alarm、Workers署名のNode検証を行う。

DATABASE_URLがあればDBのcommit/rollbackも実施し、なければNOT_CONFIGUREDを出す。メール送信やOAuthは実行しない。

<a id="phase-0-003"></a>
## 外部サービスの準備

クラウド構築にはCloudflareアカウントとSupabase開発用プロジェクトが必要です。通常のローカルゲームDBはPC内PostgreSQLを使います。準備状況と利用可能な予算を確認してから実環境へ配置する。

独自ドメインの購入は現段階の必須条件にせず、利用可能なHTTPS originを確認する。組織間参加の検証では、別originの組織を用意します。同じ組織のインスタンス追加に別Auth・DBは不要です。

| 準備 | 用途・設定先 |
| --- | --- |
| Cloudflare利用権限 | 専用Worker `quiz-relay-probe` と検証DO。既存の同名Workerがある場合は別名に変更する。Wranglerの認証はユーザーの端末で行う |
| Supabase開発用プロジェクト | Transaction pooler、DBロール、Authの検証。URL・publishable keyは設定へ、DB接続文字列は `.dev.vars` / Worker secretへ |
| 検証HTTPS origin | AuthのSite URLと許可redirect URLへ登録。ローカル確認用には `http://127.0.0.1:5173/` も登録する |
| Google OAuth設定 | Googleログイン検証時にGoogle Cloud側のOAuthクライアントとSupabaseのGoogle providerを設定する。詳細はプロジェクト準備後に案内する |
| メールの検証先 | Supabaseのメール設定で送信可能な本人のアドレス。メール送信は画面でユーザーが操作する |

秘密情報の提出は不要。準備状況・対象プロジェクト・利用範囲を確認した後、秘密を設定する具体的な操作を案内する。

<a id="phase-0-004"></a>
## DB検証の準備と実施

1. 現在の新規DB準備は[DB管理](database.md)のDrizzle手順を使う。開発基盤当時のprobe用SQLはDrizzleへ統合済みで、旧ファイルは削除した。

   現行migrationはprobeとゲームの両スキーマを作成する。
2. 管理者のpsqlセッションで `\password quiz_probe` を使い、ロールのパスワードを対話入力する。パスワードをSQLファイルやコマンド引数へ書かない。psql未導入の場合は環境に合わせた手順を別途用意する。
3. SupabaseのConnect画面のTransaction pooler接続先を使い、ユーザー部分を `quiz_probe.<project-ref>` として `.dev.vars` のDATABASE_URLへ保存する。

   実際のhost・portを画面で確認する。
4. Workerを再起動して「DBのcommit・rollback」または `pnpm run probe` を実行する。

   検証用UUID行でTX内の読取、commit後の存在、rollback後の不存在を確認し、finallyで対象行を削除する。
5. さらにanon/authenticatedで検証schemaへアクセスできないこと、通常ロールでDDLできないことを実DBで確認する。通信断時に検証行が残った場合は専用schemaを管理者が確認する。

接続はPostgres.js、`prepare: false`、`ssl: 'verify-full'`、接続数1、接続タイムアウト10秒。TLS検証を無効化して通すことはしない。

実行結果は[検証記録](../history/verification.md)を参照します。

<a id="phase-0-005"></a>
## 認証遷移の検証

SUPABASE_URLとSUPABASE_PUBLISHABLE_KEYを設定して再起動する。画面のログインボタンはSDKのPKCEを使い、公開設定・PKCE verifier・認証状態をlocalStorageへ保存する。

メールリンクは同じブラウザー・同じoriginなら別タブでも開ける。別端末・別ブラウザー・メールアプリ内ブラウザーには引き継げない。ブラウザー終了後も認証状態は残るため検証後はログアウトする。

変更前に送信したリンクは新しい保存先にverifierがないため、更新後にログインを開始し直す。これは検証画面用で、正式な開催元セッションとは別。

メールとGoogleのそれぞれで、ログイン→元の画面へ戻る→自動の本人確認結果→ログアウトを試す。「本人確認」ボタンで手動の再確認もできる。

「本人確認」は `getUser()` によるAuthサーバー確認で、トークンやメールを結果欄に出さない。redirect先の不一致、codeの再利用、別ブラウザーでのPKCE失敗も確認する。同一ブラウザーの別タブは成功対象。

メールとGoogleの過去の確認結果は[検証記録](../history/verification.md)を参照します。

<a id="phase-0-006"></a>
## クラウドでの実行

### 設定済みWorkersへのデプロイ

実行するのはユーザーの明示指示がある場合、または検証にサーバー実環境が必要な場合のみ。デザイン確認は原則 `pnpm dev` を使う。

[デプロイの判断基準](../development/rules.md)を参照。

今回の開発PCではCloudflareへのログイン、WorkerのSecret、Hyperdriveの設定は済んでいる。プロジェクトのフォルダーで次を実行する。

```powershell
cd H:\programing\quiz_relay
pnpm run build
pnpm exec wrangler deploy --var PROBES_ENABLED:true
```

ビルド後に既存のquiz-relay-probeへ配置する。公開先は https://quiz-relay-probe.quiz-relay.workers.dev/ 。

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

末尾の「Cloudflare実環境のDB経路」に従い、そのアカウントのHyperdrive・CA・Secret・Authのredirect設定を準備する。

WebSocket検証経路 `/api/probes/socket` はAuthorizationヘッダーが必要なCLI/テスト用。

ブラウザーWebSocket APIは任意ヘッダーを設定できないため、この画面にWebSocket接続ボタンは設けていない。トークンをURLへ入れる回避策は使わない。

<a id="phase-0-010"></a>
## Tailscaleからの接続

ユーザー指定により、Vite自身の自己署名HTTPSをTailscale経由で利用する。ServeやOSへのCA登録は使用していない。証明書は30日有効で、今回の期限は2026-10-08 UTC。

- 起動：`pnpm run dev`（Tailscaleへの接続が必要）
- 接続先：`https://desktop-149oae5.taildd84bf.ts.net:5173/`
- `.dev.vars`：PROBE_ORIGINを上記の末尾スラッシュなしのoriginへ設定。

  DEV_TLS_CERTとDEV_TLS_KEYには `.wrangler/tls/dev-cert.pem` と `.wrangler/tls/dev-key.pem` を指定する。どちらもGit管理外。
- 初回は自己署名の警告から「詳細設定」→対象サイトへ続行する。Edgeで実際に続行し、secure contextとWebCrypto/SHA-256の動作を確認した。全ブラウザーでの成功を保証したものではない。
- SupabaseのAuthentication → URL Configuration → Redirect URLsに上記のHTTPS URLを追加し、このURLからメールログインを開始する。
- 同じPCでもIP形式のOriginは今回のSupabase OTP preflightがHTTPSでも403だった。Tailscale DNS名では200だったため、ログイン検証にはDNS名を使用する。

  DNS名は同じ100.102.202.80へ解決する。

証明書はOpenSSLのreq -x509で生成し、SANに100.102.202.80、127.0.0.1、localhost、上記Tailscale DNS名を含める。期限切れやIP/DNS名変更時には再生成する。

Viteのserver.httpsへ証明書と鍵を渡し、外部のTLS終端サーバーは追加しない。

CLIで自己署名HTTPSを検証する場合は、コマンド用のPowerShellで `$env:NODE_EXTRA_CA_CERTS = (Resolve-Path .wrangler/tls/dev-cert.pem).Path` を設定してから `pnpm run probe` を実行する。

TLSの検証全体を無効にせず、今回の証明書をそのプロセスで信頼する。

以下のServe手順はHTTPSが必要になった場合の任意の代替手段として残す。

1. `.dev.vars` の `PROBE_ORIGIN` に自PCのTailscale HTTPS originを指定する（末尾スラッシュなし）。ViteのallowedHostsと検証APIの許可Originに使用する。

   転送ヘッダーは信頼せず、指定したOriginだけを追加で認める。
2. 代替のServe構成ではDEV_TLS_CERT / DEV_TLS_KEYを外し、`pnpm run dev --host 127.0.0.1` を起動する。

   待受は127.0.0.1:5173を維持し、ポート使用中なら別ポートへ自動変更せず停止する。
3. `tailscale serve --bg http://127.0.0.1:5173` を実行する。Serveが無効ならCLIが示す管理URLで有効化する。これはTailscale内向けServeで、Funnelではない。
4. `tailscale serve status` に表示されたHTTPS URLを開く。

   SupabaseのAuthentication → URL Configuration → Redirect URLsにもそのURL（末尾 `/` 付き）を追加する。
5. メールログインはこのHTTPS URLから開始し、同じブラウザーの同じoriginへ戻る（別タブ可）。localhostから開始したログインをTailscale側へ引き継がない。
6. 終了時は今回のHTTPS転送を `tailscale serve --https=443 off` で解除できる。既存の別サービスがある場合は対象を確認してから解除する。

`pnpm run probe` もPROBE_ORIGINのURLを使う。ローカルだけ検証したい場合は、そのコマンドに渡すPROBE_ORIGINを `http://127.0.0.1:5173` にする。

Cloudflare Vite pluginはローカルpreview用にWorker側のdistへ.dev.varsを生成することがある。distを公開ディレクトリとして丸ごと配らず、設定したclient assetsを使う。

開発サーバーでは元の.dev.varsとdist側の.dev.varsが403になることを確認した。

### メール送信が429になる場合

Supabase側の認証回数制限。連続再送を止め、Authentication → Rate Limitsで設定を確認する。

同じユーザーへの再送間隔とプロジェクト全体の上限があり、429だけでは該当する制限や解除時刻を断定できない。画面のstatus/codeも確認する。

[公式の制限一覧](https://supabase.com/docs/guides/auth/rate-limits)参照。
### DBのCA証明書

SupabaseのDatabase Settings → SSL ConfigurationからCA証明書を取得し、.wrangler/supabase-ca.crtへ保存する。

今回取得した元のファイル名はprod-ca-2021.crt。

設定済みの.dev.varsには、DATABASE_CA_CERTにPEMを改行エスケープした文字列、NODE_EXTRA_CA_CERTSに上記ファイルパスを保存した。

pnpm devはNodeの--env-file-if-existsで.dev.varsを起動時に読み込み、Miniflareの外向きTLSにもCAを追加する。起動後の環境変数変更では反映されないためサーバーを再起動する。

Postgres.jsのworkerd用TLS実装はcaオプションを渡さず、Workersランタイムの信頼CAを使う。

DATABASE_CA_CERTはNode側の検証に使い、ローカルWorkerにはNODE_EXTRA_CA_CERTSで渡す。クラウド側の信頼CA・接続方法は配置時に別途確認し、ローカル成功だけで互換性確定とはしない。

DBロールのパスワードは管理者のpsqlで `\password quiz_probe` のように対話入力します。秘密をSQLファイル・コマンド引数へ含めず、管理接続をWorkerへ渡しません。
### Cloudflare実環境のDB経路

公開検証先は https://quiz-relay-probe.quiz-relay.workers.dev 。Workers Free / Hyperdrive Freeを使用。

クラウドからのDB直接接続は500で失敗したため、証明書検証対応のHyperdrive経由を採用した。

HyperdriveはSupavisorのsession port 5432へ接続し、Supabase CAでverify-full、キャッシュ無効、接続上限5。

クラウドDBの直接検証にはTransaction pooler 6543を使います。通常のローカルゲームDBはPC内PostgreSQLです。

vite.config.tsのbuild時設定がHYPERDRIVE bindingを配置用Wrangler設定へ追加するため、配置は必ずpnpm run buildの後に行う。

この検証WorkerではPROBES_ENABLED=trueを維持します。

クラウドの検証はnode --env-file=.wrangler/.env.cloud-probe scripts/probe.mjsで行う。専用トークンはローカル用と分離してGit管理外に保存している。

WorkerのSecretはPROBE_TOKEN、SUPABASE_URL、SUPABASE_PUBLISHABLE_KEY。DB資格情報とCA検証設定はHyperdrive側にある。

クラウドのDATABASE_URLとDATABASE_CA_CERT Secretは削除済み。ローカルの.dev.varsは従来どおり保持する。

別アカウントへ配置する場合は、そのアカウントでHyperdrive/CAを作成してvite.config.tsのIDを変更する。

料金・上限は[Hyperdrive公式料金](https://developers.cloudflare.com/hyperdrive/platform/pricing/)で確認します。

今回の検証は少数のリクエストのみで、有料プランへは変更していない。
<a id="phase-0-014"></a>
## 現在の確認範囲と送信検証

開発基盤のクラウドDB・DO復帰・Authと採用方式は検証記録に記載済み。外部接続検証は署名と限定送信経路の技術基盤で区切る。

一般のDNS rebinding、別組織参加、永続nonce、本番の問題・結果配送は未実装・未検証で、[verification.md](../development/plan.md)の後続ゲートへ引き継ぐ。

初期の送信先は手動承認した https://worker.account.workers.dev の完全一致のみ。独自ドメイン、IP、別ポート、プレビュー等の余分なラベルは拒否する。

global_fetch_strictly_publicで公開経路を使い、固定path、redirect: manualと3xx拒否を併用する。peer管理APIや汎用送信APIは公開していない。

検証時はビルド・PROBES_ENABLED:trueでの配置後、次を実行する。

```powershell
node --env-file=.wrangler/.env.cloud-probe scripts/probe-egress.mjs
```

これは固定した自Workerの未実装inboxへ公開のダミー本文だけをPOSTし、JSON 404を確認する疎通試験。独立A/Bの配送成功ではない。任意の宛先や受信認証ヘッダーを転送しない。

検証終了後もPROBES_ENABLED=trueを維持します。

Google認証にはSupabase Redirect URLsの https://quiz-relay-probe.quiz-relay.workers.dev/ とGoogle OAuthのJavaScript生成元の同originを登録済み。

Supabase callback URIを維持する。クラウド操作時は.wrangler/.env.cloud-probeの専用トークンを使用する。


## ページと配置の現在の境界

`/` は query・hash を保持して `/game/` へ移動します。正式参加は `/game/`、開発参加は `/local-game/`、検証は `/debug/`。配色比較の `/design/` は廃止済みです。
現在のテーマと画面構成は[概要](../spec/overview.md)、整形は[開発ルール](../development/rules.md)を参照します。

本番buildにはHYPERDRIVEとゲームreader用GAME_HYPERDRIVEを含めます。組織DB・結果writerのクラウド配置は未確認です。
PC内DBの設定をクラウドへ流用せず、配置前に既存binding・Auth・DBとの差を確認します。
別アカウントでの初期構築・対戦保存・更新・復元を通した手順は未検証です。[構成と復旧](../design/architecture.md)。
