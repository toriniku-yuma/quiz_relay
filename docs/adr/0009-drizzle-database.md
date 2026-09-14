# ADR 0009：DB操作とmigrationをDrizzleへ統一

- 日付：2026-09-14
- 状態：ユーザー指示により採用。SQL記述は必要最小限にする。

Drizzle ORMの安定版0.45.2とKit 0.31.10を採用する。既存Postgres.jsのTLS・Cloudflare接続終了パッチは維持。独自のクエリラッパーを作らず、Drizzleの型付きselect/insert/update/delete・JOIN・upsert・transactionを直接使う。

ゲーム読込は1つのJOINクエリで取得し、問題の順序を維持する。設定反映はJSON検証、問題・hash検証、版の検索/追加、有効設定の切替をtransaction内で実行する。開催元単位の排他だけPostgreSQLのadvisory lockをDrizzleのパラメーター付きsqlで呼ぶ。これにより複数プロファイルから同時更新しても版番号が競合しない。

migrationはdrizzle/へ集約し、テーブル・制約・RLSはKitで生成、権限と不変トリガー等はカスタムSQLを使う。スキーマのCHECK式にも必要なSQL表現を保持する。過去に適用したSQLは再作成せず照合してベースライン登録する。適用済みmigrationを編集しない。

通常アプリのreader、設定CLIの専用writer、migrationの管理接続を分離する。管理APIへ文字列SQLを送る設定CLIと、SQLファイルを生成するseed CLIは撤去し、同じDB接続方式に統一した。パスワードはGit管理外で設定し、SQL・Workerへ渡さない。

詳細・再実行は[DB管理](../database.md)。この変更は1CのDB実装方式の変更であり、1Dの結果保存・管理画面の完了ではない。
