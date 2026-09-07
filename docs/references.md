# 参照資料

企画書記載の確認日：2026-09-05。本ドキュメント作成時の公式ページ参照日：2026-09-07。ページ参照は本アプリの動作確認を意味しません。連合・採点・MVPの設計は本プロジェクトの提案です。

| 資料 | 確認・利用範囲 |
| --- | --- |
| [Workers Node.js互換性](https://developers.cloudflare.com/workers/runtime-apis/nodejs/) | nodejs_compatとAPIごとの対応。常駐Nodeと同一と見なさない |
| [Hono on Workers](https://hono.dev/docs/getting-started/cloudflare-workers) | Workers向け構成・開発・デプロイの参照 |
| [Durable Objects](https://developers.cloudflare.com/durable-objects/) | 企画の参照先。具体的な永続化・AlarmのAPIは実装時に追加確認 |
| [WebSocket Hibernation](https://developers.cloudflare.com/durable-objects/best-practices/websockets/) | Hibernation時の状態再構築とWebSocket API |
| [Supabase DB接続](https://supabase.com/docs/guides/database/connecting-to-postgres) | transaction poolerとprepared statementsの制約 |
| [Supabase API保護](https://supabase.com/docs/guides/api/securing-your-api) | grantsとRLSによる公開範囲の制御 |
| [Tailwind CSS / Vite](https://tailwindcss.com/docs/installation/using-vite) | Viteプラグインによる導入。採用版は初期実装で固定 |
| [Tailwind CSS / テーマ](https://tailwindcss.com/docs/theme) | 共通の色・余白等をテーマで管理 |
| [Tailwind CSS / クラス検出](https://tailwindcss.com/docs/detecting-classes-in-source-files) | 完全なクラス文字列で状態別スタイルを定義 |

署名・正規化の公式標準、ドライバー、Auth実装の公式資料は段階0で確認・追記する。現時点のprotocol.mdは確定した標準実装手順ではない。
