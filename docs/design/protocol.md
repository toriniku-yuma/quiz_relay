# 通信プロトコル

[一覧](../README.md) ／ [組織間連携の仕様](../spec/federation.md)

**同組織の参加APIと、別組織への参加・共有の通信を分けます。**
同組織の対戦APIは実装済みです。組織間のランク・カジュアル・部屋参加、問題同期、宛先別結果配送も実装済みです。

## 通信方式

組織間は独自のHTTPS JSONを使います。ActivityPub互換は実装条件ではありません。
ActivityPubはソーシャルサービスの投稿・通知等を配信する規格です。別組織のアカウントで対戦へ参加する要件とは別です。
[W3C ActivityPub](https://www.w3.org/TR/activitypub/)。

管理者が相手のHTTPS originと公開鍵を別経路で確認して登録します。URL参加では、固定の公開鍵APIをHTTPSで取得して初回の鍵を保存しますが、peer・問題共有は自動承認しません。既存の鍵を自動更新せず、管理者による明示禁止も上書きしません。
originはpath・query・fragment・userinfoを含めず正規化し、完全一致で比較します。
本人の識別子・所属組織と、開催先のインスタンスを別々に検証します。移行前の予約では旧参加元の識別子も保存済み原本と照合します。表示名・メール・自己申告actorIdは認証に使いません。

## 実装済みの同組織参加API

以下は実装済みのローカル所属ユーザー向け経路。更新APIは同一OriginとClerkで検証したGoogle連携Bearerを必須とする。本文は最大1024bytes、未定義フィールドを拒否する。

| メソッド・パス | 本文・認可 | 応答 |
| --- | --- | --- |
| GET /api/auth/config | 公開 | provider・publishableKeyだけ、no-store |
| POST /api/matchmaking/config | Bearer | competition参照・playersPerMatch・rules。問題内容は含めない |
| POST /api/matchmaking/join | Bearer、{name, operationId} | {room, operationId}とHttpOnly cookie。同一操作は同じ参加先へ再送 |
| POST /api/matchmaking/resume | Bearer、{} | 同じactorの{room}とcookie。参加なし409 |
| POST /api/matchmaking/cancel | Bearer、{room}または{operationId} | 待機だけ取消。開始後409、古い部屋指定409。部屋未確定でも操作IDを閉鎖 |
| POST /api/matchmaking/logout | Bearer、{room} | 本人の部屋セッション・接続を失効 |
| GET /api/matchmaking/socket?room=UUID | 同一Origin・部屋cookie・WebSocket Upgrade | state/delta/ackと本人用panel |

初回セッションは認証済みsubjectと開催元から導出したactorへ結び付け、cookieはSecure/HttpOnly/SameSite=Strict、path=/api/matchmaking、最大12時間。

tokenはURL/JSONに含めない。WebSocketでは部屋cookieを認可し、初回のBearerを再送しない。ログアウト操作で失効するが、Clerk管理側の失効が既発行cookieへ即時伝播する方式ではない。

既存の部屋ID形式は `1c:<UUID>`（互換性のため保持）。組織Matchmakerが同一actorのインスタンス・モード横断の参加枠を最大2つに制限する。新参加が成立すると旧本人だけを強制離脱させ、未確認の離脱は永続台帳から再試行する。GameRoomは設定人数の異なるactor接続がそろった時だけDB固定版を再確認して開始する。取消と開始は同じDO内で直列化。

未接続予約60秒・待機部屋10分・セッション12時間の期限を復帰で延長しない。終了済みの参加要求は同じ操作IDで再送せず、開催先へ戻って本人の参加操作から新しい要求を開始する。開始後の切断猶予・終端状態・再送/復帰は[復旧設計](architecture.md)に従う。
自動マッチは初回接続後の最後の接続切れを検知した時点で予約・セッション・参加世代を閉じる。ページ移動での取消は本人の待機を全タブから解除し、開始との競合はサーバーの現在phaseで判定する。カジュアルマッチの取消も{room}または{operationId}を受け付ける。

本人履歴の `POST /api/results/overview` とゲスト対応の `POST /api/play/results` は、`section: history | ranking`、履歴の`kind: ranked | casual | room`、詳細の`resultId`、追加取得の`cursor: {finishedAt, resultId}`を受け付ける。詳細とkind/cursor、ランキングと履歴指定の併用は400。actor・ownerはサーバーで固定する。終了日時と結果IDの降順で20件ずつ返し、`nextCursor`で続きを指定する。一覧には問題本文を含めず、詳細は参加者本人に出題済み問題だけを返す。ゲストは30日期限を取得前に適用する。
認証済みの `POST /api/results/overview` は `section: self` も受け付ける。ランキング取得時には `self: {rank, rating}` を返し、`self` 指定時は本人情報だけを取得してranking/historyを空配列で返す。順位は全対象者の順位計算後に本人を抽出し、一覧の100人制限を受けない。順位なしはnull、レートは初期値1000＋保存済みランク差分とする。順位からの除外で本人のレートを初期化しない。`self` とkind/resultId/cursorの併用は400。ゲストの結果APIは履歴だけを返す。

config応答のrulesはDBで検証した公開ルール値。設定切替後の新規参加は新しいマッチング定義版を使用し、既存部屋は保存した版を保持する。正解数の目標到達によるDO結果理由は `target_reached`。

旧保存データの `seven_correct` もクライアント表示互換のため受け付ける。

上記の予約・待機・セッション時間はconfig/runtime.jsonの初期値。

新規参加のDB読込失敗は503 / GAME_DATABASE_UNAVAILABLEを返し、cookieを発行しない。

同一actorの後発要求・取消等で古くなったDB読込結果は409 / STALE_REQUESTで拒否する。DB読込は開催元の直列化区間外、予約の確定は最新状態を確認した直列化区間内で行う。

1リクエストの回数加算はDB読込前の1回だけ。

組織対応APIでは対象インスタンスを明示します。最新の登録パスは `src/shared/api-paths.ts`、対象解決と権限は組織APIで確認します。
上表のパスへ `?instance=<内部UUID>` を付けて対象を明示します。組織全体のログアウトは `/api/matchmaking/logout-all`。インスタンスを暗黙に混ぜません。

## 別組織の参加フロー

1. 所属組織でログインし、開催先のURLまたはお気に入りを開く。
2. 開催元の組織別受入方式・対戦種別、所属元の明示禁止と組織全体の個人制限を検証し、開催先が期限付き予約を作る。
3. 所属元が本人と予約先へ結び付けた署名チケットを発行する。
4. 開催先がチケットを一度だけ交換し、本人・開催instance・matchに限定したセッションを作る。
5. WebSocket認証と固定版取得が完了した異なるactorだけを開始人数へ数える。

予約だけで本人確認済みにはしません。開始後の新規actorは受け付けず、既参加者の再接続を区別します。
交換応答を失った場合は新しいチケットで同じ予約へ戻し、枠を二重作成しません。
同組織では共通Authを直接使い、外部署名通信を必須にしません。

## チケット・署名・配送契約

既存の署名プローブと、本番の組織間契約は別です。プローブが通っただけで参加・配送を完成扱いにしません。
以下の経路は通常Workerに実装済みです。同組織の既存APIは維持します。

チケットはURL・ログ・localStorageへ保存しません。開催先セッションはHttpOnly・Secure cookieで管理し、OriginとCSRFを検証します。
別origin間の受渡しは送信元・宛先を固定して検証し、メールをチケットに含めません。

署名の用途を参加・HTTP配送・永続イベントで分離します。
配送の有効期限と過去イベントの監査期間は別で、再送時もeventId・原本・原本hashを変えません。
サイズ → 構造 → 承認origin/kid/alg → 署名 → 宛先・用途・method/path → 時刻 → hash → nonce → 本文と権限の順に検査します。
重複JSONキー・非有限数・未知の版を拒否し、署名不正をDB反映まで通しません。

## 問題の同期

共有元instance・系列ID・questionId・版・hash・元カテゴリ・元難易度・利用可否を配送します。
公開出題用の本文・表示正答・読み・ひっかけ・解説・出典を含め、審査専用根拠や審査記録は含めません。
問題はサーバー間だけで受け取り、一般向けAPIへ原本を公開しません。

共有元の送信許可・停止を検証し、受け取り先カテゴリ・難易度補正・個別除外を別データとして適用します。難易度は0・1・2の固定3区分に限定します。
改訂は新questionIdと同じ系列IDで受け取り、再同期で個別除外を消しません。
同じID・版に別hashが届いたら上書きせず隔離します。
共有解除・取得失敗は新規候補から除外し、開始済みの固定内容と過去結果を維持します。

## 結果の配送

開催元だけが確定原本を発行します。INVALIDも終了状態・理由・開催元の確定レート差分を持つ結果として扱います。
所属元では開催元付きの本人履歴へ表示し、所属元自身のレートへ加算しません。
部屋・カジュアルマッチの識別を保持し、すべてのランキング指標から除外します。

配送内容はeventId・origin・resultId・matchId・開催instance・固定設定参照・開始終了時刻・種別・終了状態・理由・参加actor・勝敗・正解数・お手つき数・失格・レート差分です。
正解・問題本文・入力解答は配送しません。出題済み問題の振り返りは開催元へ移動し、開催元でも本人を認証します。
大会条件による投影、受信側による結果取消、過去レートの自動取消は採用しません。

## 受領と再試行

inboxは `(origin, eventId)` を一意にします。同じhashは重複成功、別hashは409として隔離します。
新規原本を永続化して202、重複は200を返します。受領と本人履歴への反映は別状態です。
outboxは宛先ごとの試行回数・次回時刻・lease・最終エラー・保留状態を持ちます。
結果を保存した直後に同じ結果の配送を最大2件試み、失敗や残件は毎分の定期処理で再送します。配送失敗で確定原本や送信記録を失わず、受領確認まで完了扱いにしません。即時試行はゲームの同期処理を待たせず、定期処理との競合は既存のleaseで制御します。

通信断・5xx・429は再送し、仕様違反・認証エラー・409は修正まで隔離します。
本人の参加記録に結び付く結果・匿名化通知は、新規参加の禁止後も配送を続けます。結果の`reservationId`と署名付き参加応答から保存した台帳を照合し、本人・所属組織・開催instance・mode・matchを固定します。部屋は親予約に結び付く子試合だけを受け取ります。旧形式で参加予約を持たない結果は従来の手動承認と結果共有許可を必要とします。それ以外の承認が必要な配送は停止時に保留します。試行回数だけを理由に未配送原本を捨てません。
Workerの定期処理でlease失効と未処理を回収し、プロセスのメモリだけに再試行を任せません。
エラーは `{code, retryable, correlationId}` とし、秘密を返しません。

A開催→B所属の履歴反映、重複配送、Bのレート不変、切断後の再送、取得先停止を契約テストに含めます。
送信先制限と鍵管理は[セキュリティ](security.md)を参照してください。

## 連携APIの経路

| メソッド・パス | 用途 |
| --- | --- |
| POST /api/v1/participation/reservations | 開催先の参加枠予約 |
| POST /api/v1/participation-tickets | 所属元で本人と参加予約に結び付けたチケット発行 |
| POST /api/v1/foreign-login-tickets | 所属元で本人・所属組織・対象・stateに結び付けた外部ログイン証明の発行 |
| POST /api/v1/participation/login/exchange | 開催先の外部ログインCookieへ一度だけ交換。参加枠を取らない |
| POST /api/v1/participation/login/session | 外部本人・所属名・開催先の公開インスタンスと受入種別を取得 |
| POST /api/v1/participation/login/logout | 開催先だけのログイン・参加Cookieと未交換予約を失効 |
| POST /api/v1/participation/login/rooms/:action | 参加前の部屋一覧・出題設定・本人セット。作成と入室は参加証明が必要 |
| POST /api/v1/participation/exchange | 開催先セッションへの一度限りの交換 |
| GET /api/v1/participation/socket?reservation=UUID&room=UUID | 予約専用cookieで子試合のWebSocket接続 |
| POST /federation/v1/metadata | 開催元の受入方式に従った所属元への署名付き機能・版確認。`targetInstanceId`指定時はその1件だけ |
| GET /federation/v1/key | URL参加先の公開origin・kid・Ed25519公開鍵のみを取得 |
| POST /federation/v1/questions/sync | 署名付き同期要求と認可範囲の固定snapshot取得 |
| POST /federation/v1/inbox | 結果・匿名化・利用停止イベントの受領 |

識別子はUUIDと組織origin・instanceIdを組み合わせます。共有系列IDは作成元で発行し改訂でも変えません。既存の内部IDは再生成しません。

## 参加チケットの形式

Ed25519のcompact JWSを使い、ヘッダーのalg・kid・用途を固定して検証します。有効期間は60秒、時計差は5秒まで、予約は60秒です。期限の猶予を予約の延長に使いません。
必須claimは iss・sub・aud・sourceInstanceId・hostInstanceId・mode・matchId・reservationId・authorizationId・jti・iat・exp・protocolVersion。subは所属元が導出した不変actor識別子、audは開催元origin、matchIdは予約と結び付けた開催先のIDです。表示名は検証済み所属元プロフィールから別途受け取り、認証に使いません。
参加契約の`sourceInstanceId`は旧形式との互換性のため項目名を維持し、新しい参加では所属組織のUUIDを格納します。旧予約・履歴のUUIDは書き換えず、そのまま復帰・閲覧します。問題共有で使う同名項目は実インスタンスIDのままです。
issuerとjtiを一意にし、交換とセッション作成を同一トランザクションで行います。消費記録は有効期限と時計差が過ぎるまで永続保持し、以後も期限切れチケットを拒否するため再利用できません。

通常の外部リンクには所属元origin・所属組織UUID・開催instance・種別だけをクエリに載せます。開催元自身のログインを優先し、未ログインなら開催元で乱数stateと戻り先をsessionStorageへ保存して、所属元の `/authorize-participation/?flow=login` へ同じタブで転送します。所属元のログイン済み本人を確認し、60秒の署名証明を開催先の通常画面のfragmentで返します。fragmentはHTTP要求・Refererに載らず、交換前にHistoryから除去します。state・保存先・種別・instanceの一致をブラウザーで、issuer・audience・本人・所属・state・用途・期限・再利用を開催元で検証します。証明そのものをブラウザーストレージへ保存しません。
外部ログインのJWS用途は `quiz-relay-foreign-login+jws`。参加チケットとは交換できず、表示名・組織名を署名対象に含め、ログインだけでは参加枠・開催先会員を作りません。参加ボタンでは `flow=participation` で同じ往復を行い、既存の予約に結び付いた参加チケットを交換します。新しい動線ではログインCookieの本人と参加チケットの本人も照合します。旧ポップアップのpostMessage契約は互換経路だけに残し、state・送信元Window・originを完全一致で確認します。
開催元自身が同一originの交換APIへ送り、Secure・HttpOnly・SameSite=Strict cookieを発行します。CORSで第三者にcookieを発行させません。ログインCookie `qr_foreign_login` と予約別Cookieは `/api/v1/participation` のみに送信し、最大12時間です。ログアウトでは開催元側を失効し、所属元のAuthを終了せず、所属元クエリを除いたゲスト画面へ戻します。

## 配送の形式・上限

配送は `{message: compact JWS}` とし、protocolVersion・messageType・issuer・audience・issuedAt・expiresAt・nonce・method・path・bodyHash・bodyを署名します。
bodyHashはbodyをRFC8785で正規化し、UTF-8→SHA-256→base64urlで計算します。既存ライブラリを使い、独自の暗号・JWS検証を作りません。bodyとエンベロープの両方に型とサイズ検証を適用します。
永続イベントの原本署名と、配送要求の60秒の有効期間を分離します。再送で配送署名・nonceを更新してもeventId・原本・原本hashを変えません。nonceは期限と時計差が過ぎるまで重複拒否します。

署名・base64を含む連携HTTP本文は256KiB（262,144バイト）までです。問題同期は1ページ25問以内、固定snapshotとcursorで分割します。通常の問題JSON取込の2MB・500問上限とは別です。HTTP読込みは上限を超えた時点で中止し、相手応答は5秒で打ち切ります。

メタデータの承認・組織・公開インスタンス・受入許可・snapshotの材料と、問題共有の送信許可・カテゴリ・公開内容・snapshotの材料は、それぞれDrizzleのD1 batchで同じ読み取りトランザクションから取得します。どちらもDBへの往復を7回から1回に減らし、対戦などの無関係な更新による再読込みと、並行更新で異なる版の情報が混ざることを防ぎます。batchの結果で列名が重複しないよう、共有ページは必要な列だけを選択します。[D1 batchの保証](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch)に従い、ページ間の公開情報変更は従来どおり拒否します。
メタデータ同期のlease取得と保存時の再認可も、対象・相手・job・既存キャッシュの4つの読み取りを1回のD1 batchにまとめます。DB全体の変更世代による競合検査を維持しつつ、部屋の準備操作などと重なる読み取り時間を短縮します。

peerごとに1分60要求、actorの参加予約は1分20要求を上限とします。毎分の定期処理で期限到来outboxを回収し、通信失敗は1秒から15分までの指数バックオフに0〜25%のjitterを加えて再試行します。実際の送信は次の定期実行以降となり、429ではRetry-Afterより前に再送しません。

## 同期・削除の処理

毎分の定期処理で期限に達した設定を回収し、1回2取り込み・各25問まで進めます。全ページの整合性と先頭snapshotの再確認後に反映し、途中取得を完成扱いにしません。完了・変更なしの次回確認は5分後です。新規試合の開始時はDBの最新の許諾・停止・除外・取得状態と、成功から7分以内の有効期限を確認します。取得失敗は期限内でも直ちに新規利用を閉じ、進行中の固定内容は維持します。共有元で停止した問題は完成したsnapshotからの欠落により停止し、完全削除は署名された停止イベントで即時に閉じます。分類・除外・開催先の難易度補正は通常同期で上書きしません。
カテゴリ候補は `quiz_federation_question_sources` に保存します。画面APIはキャッシュの読取と初回の取得予約だけを行い、相手APIを直接呼びません。定期処理は1回2共有元まで、成功・失敗とも5分以上空け、固定path・署名・lease・再認可で取得します。カテゴリ候補の要求には問題本文を含めません。
問題取得の失敗は60秒から15分の指数バックオフとjitterで自動再試行します。画面には取得状態を表示し、常設の手動同期ボタンは置きません。署名・版・許可の再検証成功で復帰し、実力帯の候補0による受付停止だけを再評価します。
FINISHEDとINVALIDを本人履歴へ配送します。問題本文は結果配送に含めず、振り返りは開催元の本人認証画面で行います。
匿名化・完全削除の利用停止も署名イベントとして配送し、失敗時は未完了表示と監査を残して再送します。宛先の受領と処理完了を区別し、未配送を完了と表示しません。別組織管理者による実データ消去を送信側だけで保証するものではありません。

## 外部ユーザーの部屋参加

部屋参加は `mode: room` とし、開催元のカジュアル受入許可と、所属元の明示禁止を確認します。開催元の `/api/v1/participation/rooms/:action?reservation=UUID` は一覧・設定取得・作成・入室・本人セット・準備等を、外部参加cookieと固定された本人・開催instanceで認可します。親ロビーは `/api/v1/participation/rooms/socket?reservation=UUID&room=UUID`、子試合は `/api/v1/participation/socket?reservation=UUID&room=UUID` に接続します。URLの予約IDは識別用で、cookieの秘密トークンをURLへ載せません。ブラウザーの部屋作成・持込本文は通常部屋と同じ2MiBまでとし、署名付き連携本文の256KiB上限と分けます。

所属元の1参加枠と開催元予約を親ロビーに結び付け、同じ操作の再送で別部屋を作りません。子試合の結果を配送しても親ロビーの枠は保持し、次試合前に現在の許可を再確認します。参加終了・ログアウト・12時間の期限で枠とセッションを閉じ、未確認の閉鎖を永続台帳から再試行します。

部屋開始は60秒の準備予約を永続化してから所属元の認可と出題原本を取得します。通常のロビーalarmは有効な準備予約を解除せず、期限切れの未準備操作だけを回収します。子試合のID・原本・トークンを保存した後は、同じ開始操作で回復し、別の子試合を作りません。
