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
表示名登録・変更と作問者名更新、共通テーブルのユーザー管理、処分・権限の操作ポップアップ、個人への通報と異議申し立て、過去戦績の調査、管理者引き継ぎを実装しています。297テスト・全体check・ビルド・隔離DB検証が成功し、Chromeで一覧と処分の直接保存・取消を確認しました。退会・匿名化と残る環境試験は未完了です。[実装範囲と検証状況](history/organization.md#最新の状況)を参照してください。

作問機能では隔離PostgreSQLで作問・審査・権限・日次判定・101問の候補読取・10／30／100件のページ分割・画面別取得を確認しています。Chromeの作問・承認・停止・復旧、問題管理メニュー、ページ分離、表示件数切替・検索・複数ページの詳細からの一覧条件復元、通信失敗後の再試行、20秒の通信遅延中の新規入力保持、通知リンク・自動既読、PC／スマホ幅の表示も確認済みです。[作問の検証記録と残る連携](history/questions.md)に詳細を記載しています。準備中の通常参加は管理者と対象インスタンスのモデレーターに許可しています。
1人待機中の画面移動は以前の検証で確認済みです。
出題中の2人での画面切替、Safari実機、既存クラウドの組織移行は未確認です。仕様確定と実装・検証完了は区別します。

過去の証拠が必要なときだけ、[検証記録](history/verification.md)・[組織基盤のレビュー](history/organization.md)・[回答経緯](history/decisions.md)を開いてください。
履歴は機能別に分類しています。当時の旧案や作業指示を、現在の仕様・実行許可として扱いません。
