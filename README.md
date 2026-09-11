# Quiz Relay（仮称）

独立した運営主体のインスタンスを横断して、早押しクイズへの参加、問題セット、確定結果とランキングを共有する技術デモ。

現在は0A・0Bの技術検証段階です。ローカルで動く検証画面・Worker・Durable Object・署名検証とDB検証用migrationを用意しました。実DB/Auth接続とクラウド配置は確認済みです。ゲーム本体は未実装です。

- [仕様・設計ドキュメント](docs/README.md)
- [MVP要件と画面](docs/specification.md)
- [未確定事項](docs/open-questions.md)
- [検証計画と実装順序](docs/verification.md)

React / TypeScript / Tailwind CSS、Hono on Cloudflare Workers、Durable Objects、Supabaseを採用する企画です。独自HTTPS JSONプロトコルv1を使用し、ActivityPub互換ではありません。

## 開発用の起動

[0A・0Bの実行手順](docs/phase-0.md)に従い、Node 26.8.1でpnpm install --frozen-lockfile、.dev.varsの設定、pnpm run devを実行します。検証はpnpm run check、起動済みサーバーの確認はpnpm run probeです。

[検証記録](docs/verification-results.md)にローカルの成功と未実施項目を分けて記録しています。

## Workersへのデプロイ

実行するのはユーザーの明示指示がある場合、または検証にサーバー実環境が必要な場合のみ。デザイン確認は原則 `pnpm dev` を使う。[デプロイの判断基準](docs/development.md#デプロイの判断基準2026-09-11)を参照。

設定済みの開発環境では、プロジェクトのフォルダーで `pnpm run deploy` を実行します。ビルドして既存Workerへ配置します。

公開先：https://quiz-relay-probe.quiz-relay.workers.dev/

通常は検証APIが無効になります。ログイン方法、検証APIの有効化・終了後の無効化は[クラウドでの実行](docs/phase-0.md#クラウドでの実行)を参照してください。

画面は[動作検証](https://quiz-relay-probe.quiz-relay.workers.dev/debug/)です。採用した赤白の共通テーマへ統一し、デザイン見本ページは削除しました。トップは動作検証へ移動します。構成・追加先・整形ルールは[作業方針](docs/development.md)を参照してください。
