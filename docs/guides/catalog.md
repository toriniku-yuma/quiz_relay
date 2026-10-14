# 問題・セットの管理CLI

[ドキュメント一覧](../README.md)

対象インスタンスと組織管理者を確認して、ローカルD1の初期構築・固定カタログ管理を行います。日常の投稿・審査・分類は実装済みのWeb画面を使用します。

<a id="catalog-management-002"></a>
## 準備と認可

`pnpm db:migrate --local` を適用し、通常画面で組織と管理者を登録します。CLIは `.dev.vars` の `CATALOG_SUBJECT` が対象ownerに属する組織管理者であることを、サーバーと同じ認可処理で確認します。未設定なら `CATALOG_SUBJECT_REQUIRED` で止まります。
対象ownerはコマンドの引数で必ず指定し、JSON内ownerも同じ値にします。通常インスタンスのownerは `urn:uuid:内部ID` です。プレビューではDBへ接続せず、実行時に権限と対象を再検証します。CLIはローカルD1だけに接続し、クラウドDBへ接続しません。

<a id="catalog-management-003"></a>
## 操作

UTF-8のJSONファイルに操作を記述する。最大64KiB。`--apply` なしは形式検証と操作対象のプレビューだけでDBへ接続しない。プレビューは既存IDとの競合・停止状態・DB内の候補整合性までは確認しない。

実行時にこれらを再検証する。

```powershell
pnpm catalog:manage path/to/request.json urn:uuid:<インスタンスID>
pnpm catalog:manage path/to/request.json urn:uuid:<インスタンスID> --apply
pnpm catalog:list urn:uuid:<インスタンスID>
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
New-Item -ItemType Directory -Path .wrangler/qa -Force | Out-Null
$catalogRequest | ConvertTo-Json -Depth 10 | Set-Content .wrangler/qa/catalog-request.json -Encoding utf8
pnpm catalog:manage .wrangler/qa/catalog-request.json $catalogConfig.owner
pnpm catalog:manage .wrangler/qa/catalog-request.json $catalogConfig.owner --apply
```

上記は実行するとローカル設定を変更する例です。操作用の一時JSONはGit管理外へ置き、継続して使う出題設定は `config/` で管理します。

競技条件の変更は新規参加から反映され、既存の待機列・開始済み試合の固定版へ遡及しない。

<a id="catalog-management-008"></a>
## 検証

`pnpm db:check` で隔離した実D1に全migrationを適用し、登録・改訂・停止・セット作成・旧版保持・競合rollback・ownerと管理者の認可を確認します。`pnpm run check` は入力検証・開始前の停止チェック・ゲーム回帰・型・Lint・ビルドを確認します。
このCLIの検証と、Web本人認証・公開Worker・外部配送の受入は別に確認します。
