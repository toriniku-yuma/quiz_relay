# 設計判断

[一覧](../README.md)

**現在の選択と、その理由だけをまとめます。変更時は該当箇所を書き直します。**

| 対象 | 現在の選択 | 理由・影響 |
| --- | --- | --- |
| 構成 | Workers・Hono・DO・D1 | 1試合1裁定者。早押し裁定へDB往復を挟まない。無料検証と小規模運用の費用を抑える |
| 組織 | 1配置1組織、共通Auth | インスタンス追加で別DB・Authを要求しない。権限・問題・レートは分離 |
| インスタンス切替 | 本人の明示登録をアカウント別のDB行で保存。発見一覧・管理者の作成と分離 | 別端末で同じ候補を利用でき、公開先の増加や直接URLへのアクセスで候補が増えない。登録で利用権限を付与しない |
| 組織間参加 | 組織アカウントで参加し、参加元instanceは選ばない。開催元は承認済みのみを初期値とし、禁止先以外を許可する方式にも切替可。相手組織ごとにランク・カジュアル／部屋を制限。明示禁止を優先 | お気に入りとURLを入口にし、所属元instanceの作成・停止・削除へ参加と本人履歴を結び付けない。初回取得は鍵を固定し、問題共有を自動許可しない |
| 回答 | ひらがなパネル・文字ごとの期限 | 採点・候補・期限をサーバーで検証できる。任意コード・AI裁定は使わない |
| 外部ログインの画面 | 実際のリンク元で自動本人確認し、通常の対戦画面と共通メニューへ統合。開催先の会員ログインを優先し、ログアウトは開催先だけ | 利用頻度から所属元を推測せず、閲覧で参加枠を取らない。再読込でログアウトを覆さない。OSSの配置を越える中央アカウント基盤は作らない |
| ルールと問題 | 不変版と改訂系列 | 過去試合を変えず、共有先の個別除外を改訂後も維持 |
| 問題の停止と試合 | 待機部屋の作成時に候補・出題順を固定し、停止は次の待機部屋から反映 | 改訂・差戻し・除外など通常の管理操作で待機部屋を解散させない。試合中にDBを読まず、DB停止でも進行できる |
| スタイル | Tailwind・共通テーマ・型付きprops | 部品と状態の見た目を近くに置き、独自CSSと依存を抑える |
| 見た目と音 | 赤白・Noto Sans JP・段差ボタン、基本効果音同梱・音量変更可 | 問題と操作状態を主役にする。音の失敗でも進行できる |
| ソース配置 | 機能別、ページと通信・認証を分離 | 起動・ルート定義・検証コードへ業務処理を蓄積しない |
| 整形 | Biome | 整形・Lint・import整理を統一。型検査は別に行う |
| 設定 | JSON入力からDB不変版へ反映 | 追加パーサー不要。編集中と稼働中を区別し、有効参照だけ切り替える |
| DB | D1（SQLite）をDrizzle ORM・Kitで管理 | Workerと同じ基盤で無料検証でき、接続管理が不要。認可はWorker、整合性は制約・trigger・原子的batchで守る。複数DB対応は追加しない |
| 認証 | Clerk、Googleログイン限定。検証はHobbyのDevelopment | 自前のパスワード・メール認証を提供しない。本人の識別はClerkのユーザーIDで行い、表示名やメールの一致を使わない |
| 結果 | 原本・レート差分・outboxを同一TXで保存 | 応答消失でも再試行でき、二重加算しない |
| レート | 開催インスタンス別 | 所属元へ履歴を届けても、所属元自身のレートを変えない |
| 問題共有 | 複数元・全カテゴリ／選択カテゴリ・通常／取り込み専用の保存先 | 元情報と除外を保持し、利用側で分類する。難易度は簡単・普通・難しいに固定。カテゴリ別公開と常設の手動取得は設けない |
| 画面移動 | History APIと接続の寿命を分離 | 同じタブで候補登録・管理・閲覧しても参加処理・自動待機・部屋ロビー・対戦を維持する |
| テーブルの並べ替え | 共通の列見出し操作、対象全件のソート後にページ分割 | 画面ごとの操作差をなくし、現在ページ内だけの不完全な並べ替えを避ける。閲覧ログの履歴は基準日時を固定してページずれを防ぐ |
| 運営の処分操作 | 一覧のアイコンから編集ポップアップで直接保存 | 確認画面を挟まず連続管理でき、理由付きの取消と処分中絞り込みで対応する |
| 実装順 | 組織→作問→運営→部屋→連携→UI調整・総合確認 | 識別・権限を先に固め、各機能で画面も作る |
| 外部送信 | 検査済みworkers.devのHTTPS origin・固定path・署名鍵の固定 | URLからの初回公開鍵取得と、本人の参加記録に限定した通信を認める。独自ドメインはSSRF実接続検証を済ませてから対応する |

詳細は[構成](architecture.md)・[保存](schema.md)・[通信](protocol.md)・[組織](organization.md)・[開発ルール](../development/rules.md)を参照してください。
以前の選択・理由・代替案は[原記録](../history/decisions.md)へ保存しています。現在の仕様より優先しません。

## 参照資料

資料の参照は、アプリの動作確認とは別です。採用版はlockfileと設定ファイルを確認してください。

- [Workers Node.js互換性](https://developers.cloudflare.com/workers/runtime-apis/nodejs/)
- [Hono on Workers](https://hono.dev/docs/getting-started/cloudflare-workers)
- [Durable Objects](https://developers.cloudflare.com/durable-objects/)
- [WebSocket Hibernation](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)
- [Cloudflare D1](https://developers.cloudflare.com/d1/)
- [Drizzle ORM / Cloudflare D1](https://orm.drizzle.team/docs/connect-cloudflare-d1)
- [Tailwind CSS / Vite](https://tailwindcss.com/docs/installation/using-vite)
- [Tailwind CSS / テーマ](https://tailwindcss.com/docs/theme)
- [Tailwind CSS / クラス検出](https://tailwindcss.com/docs/detecting-classes-in-source-files)
- [Cloudflare Vite plugin](https://developers.cloudflare.com/workers/vite-plugin/get-started/)
- [Durable Objectsのテスト](https://developers.cloudflare.com/durable-objects/examples/testing-with-durable-objects/)
- [jose](https://github.com/panva/jose)
- [canonicalize](https://github.com/erdtman/canonicalize)
- [Clerk Backend SDK](https://clerk.com/docs/references/backend/overview)
