# 設計判断

[一覧](../README.md)

**現在の選択と、その理由だけをまとめます。変更時は該当箇所を書き直します。**

| 対象 | 現在の選択 | 理由・影響 |
| --- | --- | --- |
| 構成 | Workers・Hono・DO・Postgres | 1試合1裁定者。早押し裁定へDB往復を挟まない |
| 組織 | 1配置1組織、共通Auth | インスタンス追加で別DB・Authを要求しない。権限・問題・レートは分離 |
| インスタンス切替 | 本人の明示登録をアカウント別のDB行で保存。発見一覧・管理者の作成と分離 | 別端末で同じ候補を利用でき、公開先の増加や直接URLへのアクセスで候補が増えない。登録で利用権限を付与しない |
| 組織間参加 | 手動承認した相手とのHTTPS JSON | 別組織のアカウントで対戦できる。ActivityPub互換とは別の要件 |
| 回答 | ひらがなパネル・文字ごとの期限 | 採点・候補・期限をサーバーで検証できる。任意コード・AI裁定は使わない |
| ルールと問題 | 不変版と改訂系列 | 過去試合を変えず、共有先の個別除外を改訂後も維持 |
| スタイル | Tailwind・共通テーマ・型付きprops | 部品と状態の見た目を近くに置き、独自CSSと依存を抑える |
| 見た目と音 | 赤白・Noto Sans JP・段差ボタン、基本効果音同梱・音量変更可 | 問題と操作状態を主役にする。音の失敗でも進行できる |
| ソース配置 | 機能別、ページと通信・認証を分離 | 起動・ルート定義・検証コードへ業務処理を蓄積しない |
| 整形 | Biome | 整形・Lint・import整理を統一。型検査は別に行う |
| 設定 | JSON入力からDB不変版へ反映 | 追加パーサー不要。編集中と稼働中を区別し、有効参照だけ切り替える |
| DB | Drizzle ORM・Kit、Postgres.js | 型付き操作とmigrationを統一。権限・triggerにはcustom SQLを使う |
| 結果 | 原本・レート差分・outboxを同一TXで保存 | 応答消失でも再試行でき、二重加算しない |
| レート | 開催インスタンス別 | 所属元へ履歴を届けても、所属元自身のレートを変えない |
| 問題共有 | 取り込み先・難易度対応・個別除外 | 元情報を保持し、利用側の分類を選べる。再同期で除外を消さない |
| 画面移動 | History APIと接続の寿命を分離 | 同じタブで候補登録・管理・閲覧しても参加処理・自動待機・部屋ロビー・対戦を維持する |
| インフォメーション | インスタンス別のルール・お知らせ画面と管理者による更新。作問ページには同じ保存内容の作問ルールを掲示 | 利用者が運営方針・告知を確認でき、作問時にもルールを読めるようにする。掲示先による内容の不一致を防ぎ、最終UI調整前に整える |
| テーブルの並べ替え | 共通の列見出し操作、対象全件のソート後にページ分割 | 画面ごとの操作差をなくし、現在ページ内だけの不完全な並べ替えを避ける。閲覧ログの履歴は基準日時を固定してページずれを防ぐ |
| 運営の処分操作 | 一覧のアイコンから編集ポップアップで直接保存 | 確認画面を挟まず連続管理でき、理由付きの取消と処分中絞り込みで対応する |
| 実装順 | 組織→作問→運営→部屋→連携→インフォメーション→UI調整・総合確認 | 識別・権限を先に固め、各機能で画面も作る |
| 外部送信 | 承認済みHTTPS origin・固定path | 標準URLと独自ドメインに対応する。独自ドメインのSSRF実接続検証は実装時の受入条件 |

詳細は[構成](architecture.md)・[保存](schema.md)・[通信](protocol.md)・[組織](organization.md)・[開発ルール](../development/rules.md)を参照してください。
以前の選択・理由・代替案は[原記録](../history/decisions.md)へ保存しています。現在の仕様より優先しません。

## 参照資料

資料の参照は、アプリの動作確認とは別です。採用版はlockfileと設定ファイルを確認してください。

- [Workers Node.js互換性](https://developers.cloudflare.com/workers/runtime-apis/nodejs/)
- [Hono on Workers](https://hono.dev/docs/getting-started/cloudflare-workers)
- [Durable Objects](https://developers.cloudflare.com/durable-objects/)
- [WebSocket Hibernation](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)
- [Supabase DB接続](https://supabase.com/docs/guides/database/connecting-to-postgres)
- [Supabase API保護](https://supabase.com/docs/guides/api/securing-your-api)
- [Tailwind CSS / Vite](https://tailwindcss.com/docs/installation/using-vite)
- [Tailwind CSS / テーマ](https://tailwindcss.com/docs/theme)
- [Tailwind CSS / クラス検出](https://tailwindcss.com/docs/detecting-classes-in-source-files)
- [Cloudflare Vite plugin](https://developers.cloudflare.com/workers/vite-plugin/get-started/)
- [Durable Objectsのテスト](https://developers.cloudflare.com/durable-objects/examples/testing-with-durable-objects/)
- [SupabaseのPostgres.js接続](https://supabase.com/docs/guides/database/postgres-js)
- [prepared statements無効化](https://supabase.com/docs/guides/troubleshooting/disabling-prepared-statements-qL8lEL)
- [jose](https://github.com/panva/jose)
- [canonicalize](https://github.com/erdtman/canonicalize)
- [Supabase PKCE](https://supabase.com/docs/guides/auth/sessions/pkce-flow)
- [PostgreSQL JSON型](https://www.postgresql.org/docs/current/datatype-json.html)
- [Supabase Management APIのSQL実行](https://supabase.com/docs/reference/api/v1-run-a-query)
