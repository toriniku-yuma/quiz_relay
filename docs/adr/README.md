# ADR 一覧

[0012-shared-question-import.md](0012-shared-question-import.md)：共有問題の取り込み先カテゴリ、元分類の保持、検索・個別除外、難易度対応。2026-09-17承認・未実装。

| ADR | 状態 | 判断 |
| --- | --- | --- |
| [0001-mvp-boundaries.md](0001-mvp-boundaries.md) | 企画採用・CSSのみ0003で更新 | 独立運営、開催元裁定、独自v1、不変版、再送と再生成 |

[0002-matchmaking-and-answer-panels.md](0002-matchmaking-and-answer-panels.md)：2026-09-07回答反映。自動マッチング、カタカナパネル、同点優勝、複数ログイン方式。Q16〜Q19も反映済み。人数の初期値は調整用の仮値。

[0003-tailwind-css.md](0003-tailwind-css.md)：ユーザー承認済み。Tailwind CSSを採用し、Reactの部品化と必要最小限の共通化を使用する。

[0004-rules-and-question-identity.md](0004-rules-and-question-identity.md)：2026-09-08要望反映。1文字ごとの制限時間、7問先取・3回お手つき失格、改訂時の新規問題ID、将来のレーティングとルーム戦。0002の該当決定を更新。

[0005-visual-design-and-sound.md](0005-visual-design-and-sound.md)：2026-09-08要望反映。素朴なフラットデザイン、凸状の回答ボタン、ユーザーが手動で割り当てる効果音。

新しい重要判断は番号付き文書に日付、状態、背景、決定、影響、代替案を記録する。提案を承認済みと表記しない。DB接続方式・署名方式は技術検証後に個別ADRで確定する。

[0006-phase-zero-foundation.md](0006-phase-zero-foundation.md)：0A・0Bのローカル検証基盤、署名プロファイル、実環境で残る検証。

[0007-source-structure-and-debug-pages.md](0007-source-structure-and-debug-pages.md)：責務別のフォルダー、1 TSX 1コンポーネント、整形、デバッグと比較ページの分離。

[0008-game-configuration.md](0008-game-configuration.md)：JSONによる人数・ルール設定、DBの不変版と有効プロファイル、将来の管理画面への接続方針。

[0009-drizzle-database.md](0009-drizzle-database.md)：型付きDB操作、Drizzle migration、専用writerと既存DBのベースライン引継ぎ。

[0010-service-specification-replan.md](0010-service-specification-replan.md)：サービス仕様の再整理、管理画面・1Eの追加、カテゴリ抽選・複数読み・改訂履歴と既存設計の見直し。実装は停止中。

[0011-organization-and-instances.md](0011-organization-and-instances.md)：組織共通の管理者・ユーザーと、インスタンス別のモデレーター・作問・レート・対戦を分離する追加提案。独立DB/Auth前提を見直し中。配置・組織間連合・移行は未確定。

[0013-persistent-match-navigation.md](0013-persistent-match-navigation.md)：同一タブの画面移動、閲覧先と接続先の分離、正式対戦の接続保持。
