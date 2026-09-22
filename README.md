# Quiz Relay（仮称）

独立した運営主体のサーバーを横断して、早押しクイズへの参加、問題共有、本人の対戦履歴共有を提供するサービス。通常ランクのレートは開催サーバーごとに独立し、大会機能は現在のスコープ外です。

2026-09-15現在、実装を停止してサービス仕様と段階計画を整理中です。最新の追加提案は、オーガナイゼーションで管理者・ユーザーを共有し、配下のインスタンスで作問・レート・対戦を個別管理する構成です。1回のセルフホスト構築で1組織を用意し、管理画面からインスタンスを追加する方針は承認済みです。問題等の共有はインスタンス別に設定します。同組織内は共通ユーザーとして参加し、別組織への参加は参加元・先のインスタンス間設定で判断します。基盤・連携契約と一括操作の詳細は確認中です。0A〜1Cは文書記載の範囲で完了し、1Dは結果保存・レート・本人履歴・管理CLIまで実装しています。管理画面・投稿審査・部屋マッチ・連合機能などは未実装です。クラウドは1C版で、最新のローカル実装とは区別します。詳細はdocsを参照してください。

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
