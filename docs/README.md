# Quiz Relay ドキュメント

**サービスを知るなら[概要](spec/overview.md)。開発するなら[開発ルール](development/rules.md)。**

## 仕様を読む

| 知りたいこと | ページ |
| --- | --- |
| 作るもの・画面・見た目 | [概要](spec/overview.md) |
| 回答・勝敗・切断復帰・レート | [対戦](spec/gameplay.md) |
| アカウント・権限・処分・退会 | [組織と運営](spec/organization.md) |
| 作問・審査・カテゴリ・難易度 | [作問と出題](spec/questions.md) |
| 非レート戦・ゲスト・持込問題 | [部屋](spec/rooms.md) |
| 他組織での対戦・問題と結果の共有 | [インスタンス間連携](spec/federation.md) |

仕様の確認事項は解消し、合意内容と技術設計を各ページへ統合しました。仕様確定と実装・検証完了は別です。

## 動かす・変更する

[起動と接続](guides/setup.md) ／ [ローカルPostgreSQL](guides/local-postgres.md) ／ [人数・ルール](guides/configuration.md) ／ [問題管理CLI](guides/catalog.md) ／ [DB管理](guides/database.md)

ゲームDBはPC内PostgreSQL、ログインはSupabase Authです。
設定のJSONを編集しただけではDBの有効版は変わりません。変更対象の手順を確認してください。

## 開発・設計を調べる

[開発ルール](development/rules.md) ／ [機能別の計画](development/plan.md) ／ [検証項目](development/testing.md)

[構成と復旧](design/architecture.md) ／ [データ保存](design/schema.md) ／ [組織設計](design/organization.md) ／ [通信](design/protocol.md) ／ [セキュリティ](design/security.md) ／ [難易度の自動更新](design/difficulty.md) ／ [設計判断](design/decisions.md)

## 実装・検証の状況

組織・インスタンス基盤、対戦・結果保存・管理CLI、同一タブの画面移動は実装済みです。
作問・審査・運営・部屋・組織間連携には未実装の範囲があります。

最新の検証では239テスト・ビルドと、隔離PostgreSQLで新規初期設定・旧ID保持・権限・バックアップ復元を確認しています。準備中の通常参加は管理者と対象インスタンスのモデレーターに許可しています。
1人待機中の画面移動は以前の検証で確認済みです。
出題中の2人での画面切替、Safari実機、既存クラウドの組織移行は未確認です。仕様確定と実装・検証完了は区別します。

過去の証拠が必要なときだけ、[検証記録](history/verification.md)・[組織基盤のレビュー](history/organization.md)・[回答経緯](history/decisions.md)を開いてください。
履歴は機能別に分類しています。当時の旧案や作業指示を、現在の仕様・実行許可として扱いません。
