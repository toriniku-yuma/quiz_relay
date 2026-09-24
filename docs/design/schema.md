# データと保存

[一覧](../README.md) ／ [DB操作](../guides/database.md)

**実装済みの列・制約は `src/worker/db/schema.ts` が正です。**
このページはデータの責任範囲を説明します。作問・部屋・組織間連携の拡張は未実装です。

## 識別と分離

組織はAuth subjectと不変actorIdを対応付けます。インスタンスは内部IDと不変ownerを持ちます。
表示名を変えても識別子・問題・結果・レートを変えません。[組織設計](organization.md)。
組織アカウントの現在の表示名は、組織IDとNFKC・前後空白除去後の名前の組で一意制約を設けます。登録・変更の同時要求でも重複を許可しません。過去結果の参加時表示名には現在名の一意制約を適用しません。
ownerを複合FKに含め、他インスタンスの同名IDへ誤結合しないようにします。
ブラウザーの anon・authenticated・PUBLIC へ内部スキーマを公開しません。

## 固定する情報と変更できる情報

| 情報 | 保存の扱い |
| --- | --- |
| ルール・問題・問題セット | 不変版。内容hashと参照版を保持 |
| 問題の本文・正答・読み・解説 | 現行は question_versions.payload 内。解答専用表は未実装 |
| 改訂 | 新questionIdを作る。改訂系列と旧IDへの関連を保持する設計へ拡張 |
| 使用停止 | 不変内容と別の question_availability で管理 |
| 有効な設定 | matchmaking_settings の参照を切り替える |
| 試合 | 開始時のルール・問題・種別・開催元を固定 |
| 結果 | 原本・各参加者の固定レート差分・outboxを同一TXで保存 |
| 表示用順位 | 開催元別の確定差分から再生成可能 |

改訂元を停止し、新しい問題を新セット版から参照します。開始済み・過去結果の参照は維持します。
現行コードの competition はマッチング定義に使う内部名です。大会機能を提供する意味ではありません。

choiceCountは既存の保存項目として4固定とし、値を変更する設定は設けません。ルールには choiceCount・characterAnswerTimeMs・correctAnswersToWin・mistakesToDisqualify・revealIntervalMs・judgedDisplayMs・fullRevealWaitMs・reconnectGraceMs・showSelections を含めます。
人数と設定版を開始前に固定し、全問題で必要な一意候補を作れるか検証します。候補不足を黙って縮小しません。

## 設定の更新

`quiz_game.matchmaking_settings` は `(owner, profile)` を主キーとし、同じownerのマッチング定義版を参照します。
開催元単位のtransaction advisory lockで版割当を直列化し、版の追加・再利用と有効参照の更新を同一TXにまとめます。
待機・進行中のDOは保存した版を保持します。[設定変更](../guides/configuration.md)。

readerはSELECTのみ、config writerはカタログ読取・ルール／定義版追加・有効参照更新だけを許可します。
catalog writerはcatalog_operatorsで許されたownerの問題登録・改訂・停止・セット作成を扱います。
Webの運営権限とCLIのDBロール認可を混同しません。

## 結果の確定

resultIdと `(owner, matchId)` を一意にします。同一ID・同一hashの再試行だけを成功扱いにし、別内容をON CONFLICTで上書きしません。
結果・参加者差分・outboxは不変トリガーで守り、専用results writerのSELECT/INSERTだけを許可します。
readerへoutboxを公開しません。

DB障害ではDOに未保存原本と再試行予定を残します。commit後の応答消失も同じ原本で再試行します。
部屋の参加枠を解放しても未保存結果を削除しません。[復旧設計](architecture.md)。

レートの計算・INVALID・同順位の扱いは[対戦仕様](../spec/gameplay.md#specification-027)を参照します。
外部結果を所属元の通常レートへ足しません。部屋・カジュアルはすべてのランキング指標から除外します。
再生成中の部分集計は見せず、入力revisionを固定して新世代へ切り替えます。計算中の追加結果は次の更新に含めます。
大会集計、結果の自動取消、世界共通順位のテーブルは今回の設計対象外です。

## 連携で追加する情報

| 情報 | 主なキー・条件 |
| --- | --- |
| 接続先と公開鍵 | 組織origin・対象instance・kid・有効期間・承認状態。旧鍵履歴を保持 |
| 許可 | 相手instance・機能・方向・ランク／カジュアル |
| 共有問題 | 共有元instance・改訂系列・questionId・版・hash |
| ローカル分類と除外 | 取り込み設定・系列ID。原本の同期で上書きしない |
| inbox | `(origin, eventId)` 一意。署名原本・hash・受領／処理／隔離状態 |
| outbox配送先 | `(origin, eventId, destination)` 一意。試行回数・次回時刻・lease・エラー |
| チケット消費 | `(issuer, jti)` 一意。期限まで永続的に重複交換を拒否 |
| 参加セッション | tokenのhash・actor・開催instance・match・期限・失効 |

受信側はinboxと原本を同一TXで保存してからACKします。受領と履歴反映は別状態として再処理可能にします。
結果共有は本人の外部対戦履歴のために使い、問題本文・正答・入力履歴は配送しません。[通信](protocol.md)。

## 制約とmigration

版は正整数、回数・勝数は非負整数。レートは負数も許可します。
JSON・文字列長・期限・件数は入力境界で検証し、DBでも可能なCHECK・FK・UNIQUEを設けます。
参照中の固定版をcascade削除しません。署名秘密鍵はDBへ保存せずWorker secretsで管理します。

outboxの状態／再試行時刻、inboxの処理状態／受信時刻、開催元／終了時刻、resultId検索にindexを設けます。
Drizzle Kitの生成・custom migrationと `drizzle.__drizzle_migrations` に管理を統一します。
既存DBは構造と履歴を照合してから移行し、初期migration・seedを再実行しません。[DB手順](../guides/database.md)。

## 作問申請の同時更新

新規申請は不変の申請IDを持ち、取下げ後の編集・再提出でrevisionを増やします。承認・差戻し・却下は提出時revisionと現在状態が一致する場合だけ更新し、競合は409で現在状態を返します。
編集・再提出・承認では担当インスタンスと現在の資格・権限を再検証します。公開改訂は新questionIdを発行し、同じ系列IDと改訂元IDで結びます。取下げ済みrevisionへの承認を受け付けません。
タグ照合はNFKC、前後空白除去、連続空白の統一、英字大小の統一を行い、表示名・別名を保持します。

## JSON入出力

UTF-8のJSONを使い、通常問題ファイルは `{version: 1, questions: [...]}` とします。2MBは2,000,000バイトと定義し、JSON全体のUTF-8バイト長を数えます。1ファイル500問以下を同時に満たします。
各問題の入力上限・必須項目は作問仕様を正とします。未知のキー・重複JSONキー・型違い・重複IDは問題番号と項目パスで表示します。解析不能なら行・列を示します。検証と認可を全件終えてから1トランザクションで下書きを保存し、不正な一部だけを黙って除外しません。

出力時は対象IDと版を固定したmanifestを作り、各問題を1回だけ書き出します。ファイルの付加情報・区切りも含めてバイト長を検証し、500問または容量上限に達する前に次ファイルへ送ります。出力中の新規投稿は含めず、後続操作として扱います。旧版を含む1問が容量上限を超える場合は該当IDを示して出力全体を未完了とし、原文を切り詰めません。
版選択は出力前に行います。BAN・資格取消後も本人の自作出力は維持し、他人の問題・審査者・運営監査は出力しません。運営出力にも担当範囲の認可を適用します。

取込み要求はactor・対象instance・requestIdを一意にし、本文hashと結果IDを保存します。同じrequestIdとhashの再送は保存済み結果を返し、別hashは409。意図的に再び取り込む場合は新requestIdで別の下書き群を作ります。JSON内の承認・公開・権限を採用しません。

カテゴリ一括分類は `{version: 1, assignments: [{questionId, categoryId}]}` を使い、同じ容量上限・500割当上限で扱います。取込プレビュー時の問題revisionとカテゴリ一覧revisionを反映時に再検証し、変わっていれば再確認を求めます。反映は全件成功か全件未変更とし、権限外・重複・不明IDを拒否します。

## 認証補助データ

新規の内部ID・共有系列IDはUUIDとし、既存IDは移行のために再生成しません。系列IDは作成元が発行し改訂でも不変です。組織origin・instanceIdを併記し、内部owner URNから通信先URLを推測しません。
ゲストはサーバー発行の暗号学的乱数256bitのセッションIDをSecure・HttpOnly・SameSite=Strict cookieで保持し、DBにはhashを保存します。ゲスト本人履歴用は30日、対戦セッションはゲーム共通の期限と復帰条件に従います。Cookie消失からの本人復元やアカウントへの移管は行いません。
ゲスト名は1〜32文字・NFKC・制御文字拒否を共通化し、所属組織アカウントの同名禁止制約へゲストを登録しません。画面ではゲストであることを区別し、名前を本人認証に使いません。
