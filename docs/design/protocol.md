# 通信プロトコル

[一覧](../README.md) ／ [組織間連携の仕様](../spec/federation.md)

**同組織の参加APIと、別組織への参加・共有の通信を分けます。**
同組織の対戦APIは実装済みです。組織間の参加・問題同期・宛先別結果配送は未実装です。

## 通信方式

組織間は独自のHTTPS JSONを使います。ActivityPub互換は実装条件ではありません。
ActivityPubはソーシャルサービスの投稿・通知等を配信する規格です。別組織のアカウントで対戦へ参加する要件とは別です。
[W3C ActivityPub](https://www.w3.org/TR/activitypub/)。

管理者が相手のHTTPS originと公開鍵を別経路で確認して登録します。未知のpeer・kidは自動承認しません。
originはpath・query・fragment・userinfoを含めず正規化し、完全一致で比較します。
本人の識別子と、参加元／開催先のインスタンスを別々に検証します。表示名・メール・自己申告actorIdは認証に使いません。

## 実装済みの同組織参加API

以下は実装済みのローカル所属ユーザー向け経路。更新APIは同一OriginとSupabaseで検証したBearerを必須とする。本文は最大1024bytes、未定義フィールドを拒否する。

| メソッド・パス | 本文・認可 | 応答 |
| --- | --- | --- |
| GET /api/auth/config | 公開 | url・publishableKeyだけ、no-store |
| POST /api/matchmaking/config | Bearer | competition参照・playersPerMatch・rules。問題内容は含めない |
| POST /api/matchmaking/join | Bearer、{name} | {room}とHttpOnly cookie。二重参加409 |
| POST /api/matchmaking/resume | Bearer、{} | 同じactorの{room}とcookie。参加なし409 |
| POST /api/matchmaking/cancel | Bearer、{room} | 待機だけ取消。開始後409、古い部屋指定409 |
| POST /api/matchmaking/logout | Bearer、{room} | 本人の部屋セッション・接続を失効 |
| GET /api/matchmaking/socket?room=UUID | 同一Origin・部屋cookie・WebSocket Upgrade | state/delta/ackと本人用panel |

初回セッションは認証済みsubjectと開催元から導出したactorへ結び付け、cookieはSecure/HttpOnly/SameSite=Strict、path=/api/matchmaking、最大12時間。

tokenはURL/JSONに含めない。WebSocketでは部屋cookieを認可し、初回のBearerを再送しない。ログアウト操作で失効するが、Supabase管理側の失効が既発行cookieへ即時伝播する方式ではない。

既存の部屋ID形式は `1c:<UUID>`（互換性のため保持）。組織Matchmakerが同一actorのインスタンス横断の二重参加を防ぎ、GameRoomは設定人数の異なるactor接続がそろった時だけDB固定版を再確認して開始する。取消と開始は同じDO内で直列化。

未接続予約60秒・待機部屋10分・セッション12時間の期限を復帰で延長しない。開始後の切断猶予・終端状態・再送/復帰は[復旧設計](architecture.md)に従う。

config応答のrulesはDBで検証した公開ルール値。設定切替後の新規参加は新しいマッチング定義版を使用し、既存部屋は保存した版を保持する。正解数の目標到達によるDO結果理由は `target_reached`。

旧保存データの `seven_correct` もクライアント表示互換のため受け付ける。

上記の予約・待機・セッション時間はconfig/runtime.jsonの初期値。

新規参加のDB読込失敗は503 / GAME_DATABASE_UNAVAILABLEを返し、cookieを発行しない。

同一actorの後発要求・取消等で古くなったDB読込結果は409 / STALE_REQUESTで拒否する。DB読込は開催元の直列化区間外、予約の確定は最新状態を確認した直列化区間内で行う。

1リクエストの回数加算はDB読込前の1回だけ。

組織対応APIでは対象インスタンスを明示します。最新の登録パスは `src/shared/api-paths.ts`、対象解決と権限は組織APIで確認します。
上表のパスへ `?instance=<内部UUID>` を付けて対象を明示します。組織全体のログアウトは `/api/matchmaking/logout-all`。インスタンスを暗黙に混ぜません。

## 別組織の参加フロー

1. 所属組織でログインし、参加元インスタンスと開催先を選ぶ。
2. 両側の参加許可・種別・個人制限を検証し、開催先が期限付き予約を作る。
3. 所属元が本人と予約先へ結び付けた署名チケットを発行する。
4. 開催先がチケットを一度だけ交換し、本人・開催instance・matchに限定したセッションを作る。
5. WebSocket認証と固定版取得が完了した異なるactorだけを開始人数へ数える。

予約だけで本人確認済みにはしません。開始後の新規actorは受け付けず、既参加者の再接続を区別します。
交換応答を失った場合は新しいチケットで同じ予約へ戻し、枠を二重作成しません。
同組織では共通Authを直接使い、外部署名通信を必須にしません。

## チケット・署名・配送契約

既存の署名プローブと、本番の組織間契約は別です。プローブが通っただけで参加・配送を完成扱いにしません。
以下は未実装機能に適用する設計です。既存の参加APIを無断で改名・廃止せず、新規経路として実装します。

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

共有元の許諾・停止・カテゴリ非共有を検証し、ローカルのカテゴリ・難易度対応・個別除外を別データとして適用します。
改訂は新questionIdと同じ系列IDで受け取り、再同期で個別除外を消しません。
同じID・版に別hashが届いたら上書きせず隔離します。
共有解除・取得失敗は新規候補から除外し、開始済みの固定内容と過去結果を維持します。

## 結果の配送

開催元だけが確定原本を発行します。INVALIDも終了状態・理由・開催元の確定レート差分を持つ結果として扱います。
所属元では開催元付きの本人履歴へ表示し、所属元自身のレートへ加算しません。
部屋・カジュアルの識別を保持し、すべてのランキング指標から除外します。

配送内容はeventId・origin・resultId・matchId・開催instance・固定設定参照・開始終了時刻・種別・終了状態・理由・参加actor・勝敗・正解数・お手つき数・失格・レート差分です。
正解・問題本文・入力解答は配送しません。出題済み問題の振り返りは開催元へ移動し、開催元でも本人を認証します。
大会条件による投影、受信側による結果取消、過去レートの自動取消は採用しません。

## 受領と再試行

inboxは `(origin, eventId)` を一意にします。同じhashは重複成功、別hashは409として隔離します。
新規原本を永続化して202、重複は200を返します。受領と本人履歴への反映は別状態です。
outboxは宛先ごとの試行回数・次回時刻・lease・最終エラー・保留状態を持ちます。

通信断・5xx・429は再送し、仕様違反・認証エラー・409は修正まで隔離します。
peer停止は配送を保留し、再承認後に再開します。試行回数だけを理由に未配送原本を捨てません。
Workerの定期処理でlease失効と未処理を回収し、プロセスのメモリだけに再試行を任せません。
エラーは `{code, retryable, correlationId}` とし、秘密を返しません。

A開催→B所属の履歴反映、重複配送、Bのレート不変、切断後の再送、取得先停止を契約テストに含めます。
送信先制限と鍵管理は[セキュリティ](security.md)を参照してください。

## 新規APIの経路

| メソッド・パス | 用途 |
| --- | --- |
| POST /api/v1/participation/reservations | 開催先の参加枠予約 |
| POST /api/v1/participation-tickets | 所属元で本人と参加予約に結び付けたチケット発行 |
| POST /api/v1/participation/exchange | 開催先セッションへの一度限りの交換 |
| GET /api/v1/rooms/{roomId}/socket | 部屋専用cookieでWebSocket接続 |
| POST /federation/v1/metadata | 承認済み相手の署名付き機能・版確認 |
| POST /federation/v1/questions/sync | 署名付き同期要求と認可範囲の差分取得 |
| POST /federation/v1/inbox | 結果・匿名化・利用停止イベントの受領 |

識別子はUUIDと組織origin・instanceIdを組み合わせます。共有系列IDは作成元で発行し改訂でも変えません。既存の内部IDは再生成しません。

## 参加チケットの形式

Ed25519のcompact JWSを使い、ヘッダーのalg・kid・用途を固定して検証します。有効期間は60秒、時計差は5秒まで、予約は60秒です。期限の猶予を予約の延長に使いません。
必須claimは iss・sub・aud・sourceInstanceId・hostInstanceId・mode・matchId・jti・iat・exp・protocolVersion。subは所属元の不変actorId、audは開催元origin、matchIdは予約と結び付けた開催先のIDです。表示名は検証済み所属元プロフィールから別途受け取り、認証に使いません。
issuerとjtiを一意にし、交換とセッション作成を同一トランザクションで行います。消費記録は有効期限と時計差が過ぎるまで永続保持し、以後も期限切れチケットを拒否するため再利用できません。

開催元画面から所属元認証ポップアップを開き、state・送信元Window・送信元origin・受取先originを完全一致で確認してpostMessageで渡します。targetOriginにワイルドカードを使いません。本人操作で開けなかった場合は許可を案内します。
開催元自身が同一originの交換APIへ送り、Secure・HttpOnly・SameSite=Strict cookieを発行します。CORSで第三者にcookieを発行させません。ログイン用トークン・チケットをURL、永続ブラウザーストレージへ載せません。

## 配送の形式・上限

配送は `{message: compact JWS}` とし、protocolVersion・messageType・issuer・audience・issuedAt・expiresAt・nonce・method・path・bodyHash・bodyを署名します。
bodyHashはbodyをRFC8785で正規化し、UTF-8→SHA-256→base64urlで計算します。既存ライブラリを使い、独自の暗号・JWS検証を作りません。bodyとエンベロープの両方に型とサイズ検証を適用します。
永続イベントの原本署名と、配送要求の60秒の有効期間を分離します。再送で配送署名・nonceを更新してもeventId・原本・原本hashを変えません。nonceは期限と時計差が過ぎるまで重複拒否します。

通常のHTTP本文は256KiB（262,144バイト）、問題JSON本体は2MB（2,000,000バイト）、署名・base64を含む問題同期のHTTP本文は3MB（3,000,000バイト）までです。符号化前後を別々に検査し、同期応答は上限までのページと署名付きcursorで分割します。HTTP読込みは上限を超えた時点で中止します。
peerごとに1分60要求、actorの参加予約は1分20要求を上限とします。毎分の定期処理で期限到来outboxを回収し、通信失敗は1秒から15分までの指数バックオフに0〜25%のjitterを加えて再試行します。実際の送信は次の定期実行以降となり、429ではRetry-Afterより前に再送しません。

## 同期・削除の処理

共有元の利用可否revisionを60秒ごとと開始直前に取得します。元instance・系列IDを一意にし、元カテゴリ名・タグ・版・利用可否を同期します。元側の削除はtombstoneとして受け取り、取得漏れと区別します。範囲移動後は取り込み条件を満たす場合だけ復帰させ、ローカルの分類・個別除外を上書きしません。
失敗時は最終成功時刻・理由・再試行ボタンを運営に表示し、一般には共有元が利用できないことだけ知らせます。署名・版・許可の再検証成功で復帰し、実力帯の候補0による受付停止だけを再評価します。
FINISHEDとINVALIDを本人履歴へ配送します。問題本文は結果配送に含めず、振り返りは開催元の本人認証画面で行います。
匿名化・完全削除の利用停止も署名イベントとして配送し、失敗時は未完了表示と監査を残して再送します。宛先の受領と処理完了を区別し、未配送を完了と表示しません。別組織管理者による実データ消去を送信側だけで保証するものではありません。
