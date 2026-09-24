# 問題・セットの管理CLI

[ドキュメント一覧](../README.md)

専用のDB管理資格情報を用意し、対象インスタンスを確認してください。投稿・審査のWeb画面とは別の手順です。

この文書は実装済みCLIの契約・手順。投稿・審査・複数読み・カテゴリ抽選等の[新サービス仕様](../spec/overview.md)は未実装で、このJSON形式を将来の作問フォームの制約にしない。

管理画面も結果保存・管理の完了条件。

最初の管理経路は専用DB資格情報を使うCLI。HTTP管理API・管理画面は追加せず、処理をsrc/worker/catalog/manage.tsへ分離した。

将来の画面もこの検証・トランザクションを再利用する。音源・効果音は次の区切り。

<a id="catalog-management-002"></a>
## 準備と認可

この作業環境は0008〜0010のmigrationと管理者登録を適用済み。既存の問題・プロファイル・人数・ルールは変更していない。

別環境では `pnpm db:migrate` 後に `pnpm catalog:setup --apply` を1回実行する。

管理者の初期登録には.env.supabase-adminのGAME_MIGRATION_DATABASE_URLを使用する。

quiz_game_catalogの新規ランダムパスワードを設定し、GAME_CATALOG_DATABASE_URLとして同ファイルへ保存する。既存キーがあれば接続と開催元を確認し、資格情報は保持する。初期登録は同時実行しない。

開催元は環境変数GAME_OWNER、未設定ならconfig/matchmaking.jsonのowner。catalog_operatorsでDBロールと開催元を結び付け、操作ごとの認可とRLSの両方で制限する。

未登録ロール・他開催元・readerによる管理を拒否する。JSONを書き換えただけで権限は広がらない。通常運用は専用管理資格情報だけを使用し、migration管理者・設定writer・結果writerとは分離する。

管理用資格情報をWorkerやブラウザーへ配置しない。

<a id="catalog-management-003"></a>
## 操作

UTF-8のJSONファイルに操作を記述する。最大64KiB。`--apply` なしは形式検証と操作対象のプレビューだけでDBへ接続しない。プレビューは既存IDとの競合・停止状態・DB内の候補整合性までは確認しない。

実行時にこれらを再検証する。

```powershell
pnpm catalog:manage path/to/request.json
pnpm catalog:manage path/to/request.json --apply
pnpm catalog:list
```

一覧は管理対象の問題ID・停止状態、セットID/版/hash、ルールID/版/設定、有効プロファイル。問題本文・正解・秘密値は標準出力へ出さない。

### 問題の登録

自作問題の入力例。出典・許諾は実際の素材に合わせて記入する。この例は説明用で、DBへ自動投入しない。

```json
{
  "operation": "register",
  "question": {
    "id": "sakura-001",
    "version": 1,
    "text": "春に咲き、花見で親しまれる花は？",
    "answer": "さくら",
    "explanation": "桜は春の花見で親しまれています。",
    "distractors": ["あ", "い", "う", "え", "お", "か", "き", "く"],
    "source": "自作",
    "permission": "このサーバーでの使用を許可",
    "demoAllowed": true
  }
}
```

idは英数字・ハイフン・下線の1〜64文字。versionは1。問題・説明は各2000文字まで、解答は正規化後のひらがな・長音で32書記素まで。

現行CLIは登録時に最低2択の成立、設定反映・開始時にルールの候補数を検証する。確定仕様は4択固定であり、登録・提出時に4択の成立を検証するよう修正する。同じID・同じ内容の再実行は変更なし。同じIDで内容を変える操作は拒否する。

### 改訂と使用停止

改訂は `operation` を `revise` とし、`questionId` に改訂元ID、`question` に新しいIDの完全な問題データを渡す。新規問題の登録と改訂元の停止を同一TXで行う。

片方が失敗したら両方rollbackする。同じIDの増版や本文の上書きは行わない。成功済みの同内容の再実行は変更なし。別の内容への同一ID再使用、停止済み元から別IDへの追加改訂は拒否する。

停止だけなら次を使う。停止の再実行は停止日時を変更しない。CLIに削除・停止解除の操作は設けない。

```json
{ "operation": "retire", "questionId": "sakura-001" }
```

停止した問題を含む旧セットでの設定反映・新規参加・開始前の再検証は失敗する。待機者は取消後に有効な新版へ参加し直す。停止操作だけで既存プロファイルの問題セットを自動交換しないため、必要なら下記の新セット作成と設定反映を行う。

開始済みの試合はDO内の固定データを使用し、過去問題・セット参照・保存済み結果を変更しない。

### 問題セット版

```json
{ "operation": "set", "setId": "season-01", "questionIds": ["sakura-002", "other-001"] }
```

登録済みで停止していない自開催元の問題を1〜100件、出題順に指定する。重複ID・未登録ID・停止問題は拒否。IDごとの版番号は自動採番し、順序も含めて同じ内容なら既存版を再利用する。既存セットを書き換えない。

結果に返るversionを設定ファイルのquestionSet.versionへ指定する。

### 人数・ルール・使用セットの反映

`configure` の `config` に、既存のconfig/matchmaking*.jsonと同じ構造を渡す。

既存publishMatchConfigを再利用し、ルール版・大会版の追加/再利用とプロファイル切替を同一TXで行う。

```powershell
$catalogConfig = Get-Content config/matchmaking.local.json -Raw | ConvertFrom-Json
$catalogConfig.playersPerMatch = 3
$catalogRequest = @{ operation = 'configure'; profile = 'local'; config = $catalogConfig }
$catalogRequest | ConvertTo-Json -Depth 10 | Set-Content request.json -Encoding utf8
pnpm catalog:manage request.json
pnpm catalog:manage request.json --apply
```

上記は実行するとローカル設定を変更する例。今回の実装・検証で既存local/defaultの人数は変更していない。既存の `pnpm config:apply:*` も維持する。

競技条件の変更は新規参加から反映され、既存の待機列・開始済み試合の固定版へ遡及しない。

<a id="catalog-management-008"></a>
## 検証

- `pnpm db:check:catalog:ddl`：全migrationを隔離名のスキーマ・ロールで実行しrollback。
- `pnpm db:check:catalog`：専用管理者の実接続。

  登録/改訂/停止、再実行、旧版保持、順序付きセット、ルール/人数反映、改訂途中失敗の原子性、別接続とのロック排他、開催元RLS、reader/結果表/所有者変更の拒否を確認。検証用データはすべてrollbackし残さない。
- `pnpm run check`：入力検証と既存ゲーム・開始前の停止チェックの回帰、型、Lint、ビルド。

新規UI・クラウドWorker配置・外部配送は対象外。管理操作は通常ゲームのAPIへ公開していない。Web管理の本人認証・権限は[組織仕様](../spec/organization.md)に従います。
