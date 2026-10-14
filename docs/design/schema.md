# データと保存

[一覧](../README.md) ／ [DB操作](../guides/database.md)

**実装済みの列・制約は `src/worker/db/schema.ts` が正です。**
このページはデータの責任範囲を説明します。作問・運営・カジュアルマッチ・部屋・組織間連携をD1の72テーブルへ保存します。migrationはDrizzleスキーマから生成します。

## 識別と分離

組織はAuth subjectと不変actorIdを対応付けます。インスタンスは内部IDと不変ownerを持ちます。
表示名を変えても識別子・問題・結果・レートを変えません。[組織設計](organization.md)。
組織アカウントの現在の表示名は、組織IDとNFKC・前後空白除去後の名前の組で一意制約を設けます。登録・変更の同時要求でも重複を許可しません。過去結果の参加時表示名には現在名の一意制約を適用しません。
ownerを複合FKに含め、他インスタンスの同名IDへ誤結合しないようにします。
D1はWorker bindingからだけ接続し、ブラウザーへDBを公開しません。本人・組織・操作権限はWorkerで確認します。

連携の再送防止記録はissuer・purpose・nonceの一意制約で原子的に消費し、業務データの更新世代とは分離します。通信のたびに組織・結果・権限の読み取りを無効化しないためです。期限消去もこの表だけに限定し、承認・参加・結果の更新は通常の整合性検査を維持します。

## 固定する情報と変更できる情報

| 情報 | 保存の扱い |
| --- | --- |
| ルール・問題・問題セット | 不変版。内容hashと参照版を保持 |
| 問題の本文・正答・読み・解説 | 現行は question_versions.payload 内。解答専用表は未実装 |
| 改訂 | 新questionIdを作る。不変の改訂系列と旧IDへの関連を保持 |
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

`quiz_game_matchmaking_settings` は `(owner, profile)` を主キーとし、同じownerのマッチング定義版を参照します。
revisionの競合検査とD1のatomic batchで版の追加・再利用と有効参照の更新をまとめます。
読み取り・更新の再計画は最大3回です。版が競合したときだけ50〜200msの待ち時間を分散させ、複数の処理が同じ間隔で競合し続けることを避けます。通常処理の待ち時間・認可・rollback・再試行回数は増やしません。
待機・進行中のDOは保存した版を保持します。[設定変更](../guides/configuration.md)。

D1にはDBロールや行単位のアクセス制御がないため、通常APIの本人・対象認可、非公開の消去Worker、管理者subjectとownerを照合する設置者用CLIを分けます。

## 結果の確定

resultIdと `(owner, matchId)` を一意にします。同一ID・同一hashの再試行だけを成功扱いにし、別内容をON CONFLICTで上書きしません。
結果・参加者差分・outboxは不変トリガーで守り、Workerの保存処理だけが原本を追加し、通常APIへoutboxを公開しません。

DB障害ではDOに未保存原本と再試行予定を残します。commit後の応答消失も同じ原本で再試行します。
部屋の参加枠を解放しても未保存結果を削除しません。[復旧設計](architecture.md)。

レートの計算・INVALID・同順位の扱いは[対戦仕様](../spec/gameplay.md#specification-027)を参照します。
外部結果を所属元の通常レートへ足しません。部屋・カジュアルマッチはすべてのランキング指標から除外します。
再生成中の部分集計は見せず、入力revisionを固定して新世代へ切り替えます。計算中の追加結果は次の更新に含めます。
大会集計、結果の自動取消、世界共通順位のテーブルは今回の設計対象外です。

## カジュアルマッチ・部屋の保存

| 情報 | 保存先・責任 |
| --- | --- |
| 有効設定・ゲスト受入 | `instances.casual_config`。カジュアルマッチ有効、人数2〜4、カジュアルマッチ／部屋のゲスト受入。既存の個別停止理由も参加認可へ適用 |
| ランク人数 | 既存の `competitions.players_per_match`。参加設定の保存で全実力帯へ新しい不変版を発行し、有効参照を切り替える。カジュアルマッチ人数と独立し、列の追加や旧版の更新はしない |
| ゲスト本人 | `guest_sessions`。Cookie乱数のSHA-256、組織・表示名・30日期限。期限切れの行を消去Workerで削除 |
| 本人の保存問題セット | `personal_question_sets`。組織・作成者・revision・問題。本人だけがCRUD／出力でき、退会時と復元後の再消去で削除 |
| 公開部屋の検索 | `room_directory`。インスタンス・公開・閉鎖状態。参加状態・未出題内容は保持しない。表示前に親DOの公開状態を再確認 |
| ロビー・開始の固定要求 | 親DO。操作ID・要求hash・revision、参加権、設定、持込内容と期限 |
| 試合と結果 | 子DOと既存の結果／outbox。部屋ごとに新しい試合ID・結果IDで固定。`kind`と専任／ゲストを保持し、非レート差分は0 |

D1のmigrationで列・表・FK・indexと不変保護を管理します。ブラウザーのDB直接接続は提供しません。ゲストは通報者になれますが個人通報の対象にはできず、対象ユーザーのFKは登録アカウントに維持します。持込問題は出題済み内容だけを30日公開し、問題通報自体の365日保持とは分けます。

## 連携の保存情報

| 情報 | 主なキー・条件 |
| --- | --- |
| 接続先と公開鍵 | 組織origin・対象instance・kid・有効期間・承認状態。旧鍵履歴を保持 |
| 参加許可 | organizationsの外部参加方式・更新世代と、federation_peersの承認・明示禁止・ランク／カジュアルの受入許可。承認と禁止は独立して保存 |
| 問題共有許可 | `quiz_federation_policies` の自instance・相手origin・相手instanceごとの `send_questions`・`receive_questions`。初期値はどちらもオフ。参加の受入方式・結果配送とは独立 |
| URL取得先 | `(source_organization_id, peer_origin, instance_id)`。参加元の自組織IDごとに署名確認済みの対象1件を保存し、未使用・お気に入りなしの取得先は30日で整理 |
| 本人の参加記録 | `(peerOrigin, reservationId)`。本人actor・所属組織（`source_organization_id`）・開催instance・match・modeを固定し、結果と匿名化通知の受信を限定。表示名や問題本文は持たない |
| 共有問題 | 共有元instance・改訂系列・questionId・版・hash |
| ローカル分類と除外 | 取り込み設定・系列ID。原本の同期で上書きしない |
| 取り込み専用カテゴリ | カテゴリの `import_only`。通常投稿・JSON取込・通常問題の移動をAPIで禁止 |
| 共有元カテゴリの候補 | `quiz_federation_question_sources` の `(instance_id, peer_origin, source_instance_id)`。名前・取得日時・次回予定・lease・エラーを保持。画面APIはキャッシュを読み、定期処理で取得 |
| inbox | 結果・制御とも `(peerOrigin, eventId)` 一意。署名原本・hash・受領／処理状態・競合hash |
| outbox配送先 | 結果は `eventId` 主キーと `(resultId, peerOrigin, sourceActorId)` 一意、制御は `(eventId, peerOrigin)` 一意。試行回数・次回時刻・lease・エラー・隔離状態 |
| チケット消費 | `quiz_federation_nonces` の `(issuer, purpose, nonce)` 一意。jtiをnonceとして期限まで重複交換を拒否 |
| 参加セッション | tokenのhash・actor・開催instance・match・期限・失効 |
| 外部ログイン | tokenのhash・所属origin・所属組織・所属actor・表示名・組織名・12時間の期限。参加予約やClerk会員とは独立 |

受信側はinboxと原本を同一TXで保存してからACKします。受領と履歴反映は別状態として再処理可能にします。
開催元の参加予約と所属元の結果inboxは所属組織IDを `source_organization_id` に保存します。結果配送は本人の外部対戦履歴のために使い、問題本文・正答・入力履歴は配送しません。[通信](protocol.md)。

参加用キャッシュには自組織IDを保存し、Workerで自組織の範囲を検証します。URL取得先・メタデータ・同期ジョブは所属元instanceへのFKを持たず、問題共有の対象instanceへの制約を持ちます。本人の外部履歴は組織アカウントで取得します。
`quiz_federation_login_sessions` には期限・本人の索引、参加予約には本人索引を設けます。ログインCookieの秘密はhashだけをDBへ保存し、期限到来時は参加清掃で最大100件ずつ削除します。

## 制約とmigration

版は正整数、回数・勝数は非負整数。レートは負数も許可します。
JSON・文字列長・期限・件数は入力境界で検証し、DBでも可能なCHECK・FK・UNIQUEを設けます。
参照中の固定版をcascade削除しません。署名秘密鍵はDBへ保存せずWorker secretsで管理します。

outboxの状態／再試行時刻、inboxの処理状態／受信時刻、開催元／終了時刻、resultId検索にindexを設けます。
Drizzle Kitの生成・custom migrationと migration journalとD1の適用履歴 に管理を統一します。
データのあるDBへ初期seedを再投入しません。[DB手順](../guides/database.md)。

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

内部ID・共有系列IDはUUIDとします。系列IDは作成元が発行し改訂でも不変です。組織origin・instanceIdを併記し、内部owner URNから通信先URLを推測しません。
ゲストはサーバー発行の暗号学的乱数256bitのセッションIDをSecure・HttpOnly・SameSite=Strict cookieで保持し、DBにはhashを保存します。ゲスト本人履歴用は30日、対戦セッションはゲーム共通の期限と復帰条件に従います。Cookie消失からの本人復元やアカウントへの移管は行いません。
ゲスト名は1〜32文字・NFKC・制御文字拒否を共通化し、所属組織アカウントの同名禁止制約へゲストを登録しません。画面ではゲストであることを区別し、名前を本人認証に使いません。
