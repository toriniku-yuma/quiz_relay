# 作問機能のDB権限

以下はD1移行前のPostgreSQLの権限設計です。現在のDB接続・認可・検証は[DB管理](../guides/database.md)・[セキュリティ](security.md)・[移行検証](../development/testing.md#d1-clerk)を参照してください。旧ロールや旧スクリプトによる権限設定を、現在の通常環境へ適用しません。

サーバー専用ロール `quiz_organization` が、認証済みユーザーをAPIで認可した後、対象インスタンスのデータを操作します。ブラウザー用の `anon`・`authenticated`・`PUBLIC` には権限を追加しません。

## 既存カタログ（承認済み）

`question_versions`・`question_sets`・`question_set_items`・`ruleset_versions`・`competitions`・`question_availability`・`matchmaking_settings` に SELECT / INSERT。
UPDATE は `question_availability.retired_at` と `matchmaking_settings.competition_id, competition_version` のみです。DELETE は許可しません。
RLS は認証から得た組織IDをトランザクション内に設定し、その組織のインスタンス owner に制限します。

## 新規ワークフロー表（ローカル検証環境へ適用済み）

ユーザーのローカル検証許可に基づき、`scripts/question-local-permissions.ts` で以下を設定した。接続先は127.0.0.1の指定ポート・指定DB名だけに限定する。本番の新規11表へのGRANTはマイグレーションに含めておらず、本番適用の承認・作業は別途必要。

| 表 | quiz_organization に必要な操作 | 用途 |
| --- | --- | --- |
| question_settings | SELECT / INSERT / UPDATE | 投稿方式・通知等の設定 |
| question_categories | SELECT / INSERT / UPDATE | カテゴリの作成・廃止 |
| question_submissions | SELECT / INSERT / UPDATE | 下書き・提出・審査・改訂 |
| question_authors | SELECT / INSERT / UPDATE | 作問者資格 |
| question_notifications | SELECT / INSERT / UPDATE | 本人宛て通知と既読 |
| question_tags | SELECT / INSERT / UPDATE | タグと別名・統合 |
| question_submission_events | SELECT / INSERT | 不変の改訂・審査履歴 |
| question_imports | SELECT / INSERT | JSONの二重取込防止 |
| question_review_cases | SELECT / INSERT / UPDATE | 通報の集計・再審議・解決 |
| question_reports | SELECT / INSERT | 不変の本人通報 |
| question_difficulty | SELECT / INSERT / UPDATE | 難易度と日次推定の状態 |

新規11表にもRLSを有効にし、認証済み組織IDに属するインスタンスへ限定します。匿名・ブラウザー用ロールへの権限追加、既存の問題本文・過去版のUPDATE、DELETEは含みません。

ローカル環境の再現は `node scripts/setup-question-local.ts`。既存DBをpg_dumpでバックアップしてからマイグレーションとローカル権限を適用する。秘密値は出力しない。

移行前の難易度の定期処理は `QUESTION_DIFFICULTY_ENABLED=true` の明示設定がない限りDBへ接続しない構成でした。現在のD1での定期処理は[運用手順](../guides/operations.md)を参照してください。
