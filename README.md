# Quiz Relay（仮称）

独立した運営主体のインスタンスを横断して、早押しクイズへの参加、問題セット、確定結果とランキングを共有する技術デモ。

現在は仕様策定段階です。アプリケーション、migration、実行可能なデプロイ手順はまだありません。人数・時間・性能の記述は検証実績ではありません。

- [仕様・設計ドキュメント](docs/README.md)
- [MVP要件と画面](docs/specification.md)
- [未確定事項](docs/open-questions.md)
- [検証計画と実装順序](docs/verification.md)

React / TypeScript / Tailwind CSS、Hono on Cloudflare Workers、Durable Objects、Supabaseを採用する企画です。独自HTTPS JSONプロトコルv1を使用し、ActivityPub互換ではありません。
