# 設定の変更

2026-09-14。人数・ルール・使用する問題セットはJSONで指定し、コマンドでDBへ反映する。通常の設定変更でTypeScript・SQL・大会版番号を編集する必要はない。初期値は4人、現在のローカル検証は2人を維持している。

## 設定ファイルの使い分け

| ファイル | 内容 | 反映方法 |
| --- | --- | --- |
| `config/matchmaking.json` | 標準の人数・ルール・DB問題セット参照。初期4人 | `default` プロファイルへ反映 |
| `config/matchmaking.local.json` | ローカル検証用の同じ項目。現在2人 | `local` プロファイルへ反映 |
| `config/runtime.json` | WebSocket監視・再接続、待機・予約・セッション期限、ルーム数・接続数・操作回数・イベント保持の運用値 | 開発サーバー再起動。本番ビルドは再ビルド・配置 |
| `wrangler.jsonc` / `.dev.vars` | 開催元 `GAME_OWNER`、参照する `GAME_CONFIG_PROFILE`、binding・環境別接続 | 環境に応じて再起動・配置 |
| `.env.supabase-admin` | 設定writer・migration管理者のDB接続。Git管理外 | CLI専用 |

秘密はconfig配下へ入れない。問題本文・正解も含めず、既存DBの問題セットID・版を参照する。初期投入問題の `supabase/seeds/mock-hiragana.json` は別用途で、アプリへ同梱しない。

## 人数を変更する例

ローカルなら `config/matchmaking.local.json` の `playersPerMatch` を2〜4の整数へ変更し、次を実行する。

```powershell
pnpm config:apply:local
```

これで新規マッチングへ反映される。既に参加中なら、待機を取り消して参加し直す。進行中の試合はそのまま完了する。4人へ戻す場合も同じJSONの値を4へ変更して同じコマンドを使う。

用途別コマンドはpackage.jsonへ登録済みで、ファイル名・プロファイル・`--apply` の指定を省略できる。いずれも実際にDBへ反映する。標準設定は次で反映する。

```powershell
pnpm config:apply:default
```

プレビューは `pnpm config:apply config/matchmaking.local.json local` を使う。JSON検証と設定内容のJSON表示だけで、ネットワークアクセス・DB変更はしない。別ファイル・別プロファイルには汎用の `pnpm config:apply <config.json> <profile> [--apply]` を使う。DB内の問題との整合性検証は `--apply` 時に行う。

CLIは `.env.supabase-admin` の `GAME_CONFIG_DATABASE_URL` で専用writerとしてDrizzle経由で接続する。CAは `.dev.vars` の設定を使う。この環境では登録済み。別プロジェクトの接続・権限は[DB管理](database.md)を参照。成功時はプロファイル・大会ID・版・人数だけを表示する。

JSONを保存しただけでは稼働中DBへ反映されない。DB反映後は、既に同じプロファイルを参照しているアプリの再起動・デプロイは不要。プロファイルは環境の参照先名で、現在はローカル `.dev.vars` が `local`、Wranglerの既定が `default`。`GAME_DEFINITION_VERSION` と `GAME_COMPETITION_ID` は廃止した。

## 人数以外の項目

| JSON項目 | 意味 | 現行初期値・許容範囲 |
| --- | --- | --- |
| `playersPerMatch` | 接続がそろうと開始する人数 | 4人（ローカル2人）、2〜4 |
| `rules.correctAnswersToWin` | 勝利する正解数 | 7、1〜100 |
| `rules.mistakesToDisqualify` | 失格になるお手つき数 | 3、1〜100 |
| `rules.choiceCount` | 文字パネルの候補数 | 4、2〜8。DBセットの候補不足も拒否 |
| `rules.revealIntervalMs` | 本文1書記素の表示間隔 | 100、1〜10000ms |
| `rules.characterAnswerTimeMs` | 1文字の解答期限 | 3000、1〜60000ms |
| `rules.judgedDisplayMs` | 判定の表示時間 | 2000、1〜60000ms |
| `rules.fullRevealWaitMs` | 全文表示後の待ち時間 | 10000、1〜60000ms |
| `rules.reconnectGraceMs` | 人数不足で停止した試合の復帰猶予 | 30000、1〜60000ms |
| `rules.showSelections` | 受理した選択文字の共有 | true / false |
| `questionSet.id` / `version` | 使用するDB問題セットの固定版 | mock-hiragana / 1 |
| `owner` / `competitionId` / `rulesetId` | 開催元・大会・ルールの識別子 | 通常は変更不要 |

数値は整数のみ。未定義キー・欠落・型違いを拒否する。人数2〜4などの許容範囲は実装が対応する制約であり、範囲自体の拡張はコード・DB制約の変更と検証が必要。得点集計の採用判断と管理画面は1Dに残す。

runtimeの値も正の整数として読み込み時に検証し、heartbeat間隔が監視期限以上になる設定、再試行間隔が再試行期間以上になる設定、予約期限＞待機期限＞セッション期限となる不整合を拒否する。運用設定は試合ルールと異なり、再起動後の既存接続にも作用する。保存済み期限を延長する操作は行わない。HTTP本文の上限やIDの形式などの入力契約・実装上の制約は設定へ移さない。

## DBでの固定と将来の管理画面

反映コマンドはJSONと既存問題のhash・候補を検証し、変更があればルール版・大会版を追加する。同じ内容の版があれば再利用する。開催元単位のDBロックとトランザクションで版の割当と `quiz_game.matchmaking_settings` の参照切替をまとめる。過去のルール・大会・問題は更新しない。

新規参加は有効プロファイルをDBから読み、待機列を大会版ごとに分ける。待機中・進行中の試合は保存済み版を維持し、開始直前はその版の問題停止状態などを再検証する。DBに有効設定がなければ参加を拒否し、同梱設定へフォールバックしない。

将来の管理画面ではフォームから同じ構造のJSONを送り、同じ検証・版追加・有効参照切替を使える。管理画面と書込APIは今回未実装。アプリ用DBロールは読取専用のままで、CLI用のwriter・管理者接続をWorkerやブラウザーへ渡さない。

## 形式の比較と初期導入

JSONは追加パーサー不要で、CLI・将来のAPI・DBのJSONBで同じデータ構造を使えるため採用した。JSONCはコメントを置けるが読込パーサーが必要で、YAMLも今回の単純な数値・真偽値・参照に対して依存を増やす。項目の説明はこの文書へ集約する。WranglerのJSONCはツール所定の形式として維持する。[ADR 0008](adr/0008-game-configuration.md)参照。

別環境は[DB管理](database.md)のDrizzle migration・初期seed・プロファイル登録の順で準備する。この環境は既存構造を照合してDrizzle履歴へ移行済み。旧SQLを再適用しない。

2026-09-14レビュー修正：ルールの必須項目・型・許容範囲を編集対象JSONから独立させた。標準JSONも読込時に検証し、必須項目の削除や未知キーを拒否する。人数・各ルールの設定値と許容範囲は変更していない。
