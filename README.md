# Quiz Relay（仮称）

少しずつ表示される問題を早押しで解く、マルチ対戦クイズです。
1組織でアカウントを共有し、複数インスタンスの問題・対戦・レートを個別管理します。
別組織との参加・問題・本人履歴共有も計画しています。大会機能は対象外です。

**[ドキュメント一覧](docs/README.md)** から、必要なページを開いてください。

## ローカルで動かす

1. [開発環境](docs/guides/setup.md)に従い、Node 26.8.1と `pnpm install --frozen-lockfile` を準備する。
2. `.dev.vars` と [ローカルPostgreSQL](docs/guides/local-postgres.md)を設定する。
3. `pnpm dev` で起動し、`/game/` を開く。DBはPC内、ログインはSupabase Authを使う。

通常の検証は `pnpm run check`、起動済みサーバーの確認は `pnpm run probe`。
[検証項目](docs/development/testing.md)と[実施済みの記録](docs/history/verification.md)を分けています。

## 開発の現在地

組織・インスタンス基盤、対戦・結果保存・レート・本人履歴・管理CLI、共通メニューを実装しています。
組織基盤の総合受入は未完了。投稿審査・部屋・連合などには未実装の範囲があります。
[計画](docs/development/plan.md)・[仕様と設計の一覧](docs/README.md)・[作業ルール](docs/development/rules.md)を確認してください。

React・TypeScript・Tailwind CSS、Hono on Cloudflare Workers、Durable Objects、PostgreSQL、Supabase Authを使います。
連合は独自HTTPS JSONプロトコルv1の設計で、ActivityPub互換ではありません。

## Workersへの配置

配置するのはユーザーの明示指示がある場合、またはサーバー実環境での検証が必要な場合です。
デザイン確認は原則 `pnpm dev`。[配置の判断と手順](docs/guides/setup.md)に従ってください。

設定済み環境の `pnpm run deploy` はビルドして既存Workerへ配置します。
通常の配置は検証APIが無効になりますが、検証Workerには `PROBES_ENABLED=true` を維持する指定があります。
対象に合うコマンド・認証設定を手順で確認してください。

[公開先](https://quiz-relay-probe.quiz-relay.workers.dev/) ／ [接続確認](https://quiz-relay-probe.quiz-relay.workers.dev/debug/)。
クラウドの記録は組織対応前の認証付き対戦版で、最新ローカル実装とは別です。ローカルの `/` は `/game/` へ移動します。
赤白テーマを採用し、比較用 `/design/` は削除済みです。
