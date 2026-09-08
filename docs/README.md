# Quiz Relay ドキュメント

作成日：2026-09-07。ユーザー提示の技術デモ企画書を基にした初期仕様です。

## 文書の状態

「回答反映」は2026-09-07および2026-09-08のユーザー回答を反映した方針、「企画要件」は提示された方針、「提案」は実装を具体化するための仮置き、「未決」は回答・検証待ちです。提案は採用済みと扱わず、関係する実装前に確定します。動作・性能・デプロイはすべて未検証です。企画で言及された付属モック、protocol.md、self-host.mdの現物は提供されていないため、本書群は新規の草案です。

現在のフロントエンド構成はReact + TypeScript + Tailwind CSSです。[ADR 0003](adr/0003-tailwind-css.md)にユーザー承認済みの採用判断を記録しています。

## 読む順序

| 文書 | 内容 |
| --- | --- |
| [specification.md](specification.md) | 目的、MVP、画面、ルール、ランキング |
| [architecture.md](architecture.md) | 責務、対戦状態、永続化と復旧 |
| [protocol.md](protocol.md) | 参加チケット、問題共有、結果配送のv1提案 |
| [schema.md](schema.md) | データ構造、制約、順位投影 |
| [security.md](security.md) | 認可、秘密、SSRF、運用 |
| [self-host.md](self-host.md) | A/Bの独立デプロイ手順案 |
| [verification.md](verification.md) | 実装段階、テスト、発表、受入条件 |
| [open-questions.md](open-questions.md) | 回答記録・追加確認・技術検証待ち |
| [development.md](development.md) | 実装・文書更新の作業方針 |
| [ADR](adr/README.md) | 設計判断と理由 |
| [references.md](references.md) | 公式資料と確認範囲 |

## 用語

- **所属元**：プレイヤーのAuthを管理し、本人確認を行うインスタンス。
- **開催元**：試合を進行し、裁定・採点・結果確定を行うインスタンス。
- **peer**：管理者が手動承認した連合先。承認は各運営主体の判断。
- **actor**：所属元originと不変のsubjectで識別するプレイヤー。表示名は識別子ではない。
- **大会（competition）**：複数試合の集計条件を固定した単位。
- **ルーム**：参加・接続と対戦裁定の単位。**試合（match）**は1回の対戦。
- **確定**：開催元Postgresへの結果とoutboxの保存が完了した状態。各peerへの同期完了とは別。

UI説明文の初期原稿は `content/*.md` に置き、競技の数値条件はDBの固定版から表示します。概要は[ルートREADME](../README.md)を参照してください。
