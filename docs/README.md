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

[退会・削除・保存期限の運用](guides/operations.md)

通常アプリとローカル開発のDBはD1、認証はClerkのGoogleログインです。既存42テーブルのコピー・照合とローカル切替が完了し、旧PostgreSQLは移行元原本として保持しています。クラウド本データの移送と実機受入は別に確認します。[移行条件](development/plan.md#d1-clerk)・[Clerkの準備](guides/setup.md#clerk-free)を参照してください。
設定のJSONを編集しただけではDBの有効版は変わりません。変更対象の手順を確認してください。

## 開発・設計を調べる

[開発ルール](development/rules.md) ／ [機能別の計画](development/plan.md) ／ [検証項目](development/testing.md)

[構成と復旧](design/architecture.md) ／ [データ保存](design/schema.md) ／ [組織設計](design/organization.md) ／ [通信](design/protocol.md) ／ [セキュリティ](design/security.md) ／ [難易度の自動更新](design/difficulty.md) ／ [設計判断](design/decisions.md)

## 実装・検証の状況

外部対戦は、実際のリンク元で本人確認して開催先へ自動ログインし、通常の対戦画面と共通メニューを使います。開催先の会員ログインを優先し、ログアウトは開催先だけ終了します。[変更したUIの確認箇所](development/testing.md#federation-ui-changes)をまとめています。

組織・インスタンス、作問・審査、運営、ランク・カジュアル・部屋、D1・Clerk、インスタンス間連携を実装しています。通常API・管理CLI・非公開消去Worker・定期処理はD1へ移行済みです。インスタンスのトップ・お知らせ・作問ルール掲示、遊び方、効果音は未実装で、今回の移行・連携の対象外です。

インスタンス切替は本人のお気に入りを保存します。外部先はお気に入りかURLから開き、参加元インスタンスを選ばず、組織アカウントで参加します。開催元は「承認済みの組織だけ許可」か「禁止した組織以外は許可」を選び、相手組織ごとにランク・カジュアル／部屋を制限できます。所属元の明示禁止は維持し、承認済み一覧は必要時だけ表示します。一覧は自動取得し、失敗時だけ再試行を表示します。画面移動で現在の待機・ロビー・対戦を維持します。別組織参加・結果配送・開催元の振り返り、共有問題の分類先指定・固定3区分の難易度・検索・個別除外、匿名化と停止の連携を実装しています。

全体検査、隔離した実D1・DO、旧DBのコピー照合とローカル切替、無料の公開A/B配置を確認済みです。公開Chromeでは実Googleログイン・外部ランク・部屋対戦・所属元履歴・開催元の振り返りと、共有問題の取り込み・検索・除外を確認しました。

仮想利用者による公開A/Bの30分負荷試験は合格しています。外部ログインのUI変更後の長時間試験、切断原因の特定、実機・本番配置などの未確認範囲は[現在の検証範囲](development/testing.md#d1-clerk)を参照してください。実装完了と実機・運用の受入を区別します。

過去の証拠が必要なときだけ、[検証記録](history/verification.md)・[組織基盤のレビュー](history/organization.md)・[回答経緯](history/decisions.md)を開いてください。
履歴は機能別に分類しています。当時の旧案や作業指示を、現在の仕様・実行許可として扱いません。
