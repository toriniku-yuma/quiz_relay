# データ設計（論理スキーマ案）

2026-09-13：1Cの固定版カタログ用migrationを追加し、既存Supabaseへ新規quiz_gameスキーマとして適用済み。物理スキーマと検証待ちの項目は[1C手順](phase-1c.md)を参照。問題の非公開データはquestion_versions.payloadにまとめ、question_answersは現時点で独立テーブルにしていない。結果・配送・順位は未実装。以下は全体の論理設計であり、全テーブル実装済みを意味しない。既存Supabaseへの新規スキーマ追加・権限・不変版・専用reader接続を検証済み。完全な空プロジェクトからの再構築は未実施。

## 公開境界

内部テーブルは非公開スキーマへ配置する。ブラウザー向けには必要最小限のAPI・viewだけを公開し、問題本文の未表示部分、許容解答、配送原本を公開しない。入力解答は共有設定オンの試合で受理済みの選択文字だけを公開し、オフの場合は配信しない。署名秘密鍵はDBテーブルに保存せずWorker secretsで管理する。

| テーブル | 主な属性・キー | 制約・用途 |
| --- | --- | --- |
| instances | id, origin | 正規化origin一意 |
| instance_keys | instance_id, kid, public_key, valid_from, valid_until, status | instance+kid一意。旧鍵履歴を保持 |
| peers | instance_id, approval_state, approved_at | pending/approved/suspended/rejected。承認履歴を別途保持 |
| actors | actor_id, home_origin, subject, display_name | home_origin+subject一意。表示名は非一意 |
| ruleset_versions | owner, ruleset_id, version, rules_hash, config | owner+id+version一意。過去版不変 |
| question_versions | owner, question_id, version, body, explanation, source, permission | owner+id+version一意。改訂は新しいquestion_idで追加。同じIDの増版で改訂しない |
| question_answers | owner, question_id, version, accepted_answers, panel_readings, distractors | 問題版へのFK。表示用正答とパネル用ひらがな読みを分離。ダミー候補を含め非公開 |
| question_sets | owner, set_id, version, manifest_hash, permission | owner+id+version一意 |
| question_set_items | owner, set_id, set_version, ordinal, question_owner, question_id, question_version | セット版と問題版へのFK。セット内ordinal一意 |
| competitions | owner, competition_id, definition_version, rules_hash, scoring_version, start_at, end_at, conditions | 開始後は定義不変。start_at < end_at |
| competition_hosts | competition識別子, host_origin | 認定開催元。固定大会定義の一部 |
| matches | host_origin, match_id, competition識別子, 固定版, started_at, finished_at, status, invalid_reason | INVALIDは集計対象外。host+match_id一意。結果から固定条件を追跡可能 |
| participants | host_origin, match_id, actor_id, joined_at, correct_count, mistake_count, disqualified | 試合+actor一意。再接続で追加しない |
| answers | host_origin, match_id, question識別子, actor_id, command_id, adjudication_seq, verdict, score_delta | 裁定連番一意。入力解答の保存は必要性と保持期限を確定してから |
| result_events | origin, event_id, result_id, event_type, target_origin, target_result_id, payload_hash, signed_payload, validation_state | origin+event_id一意。確定イベントはorigin+result_id一意 |
| result_revocations | target_origin, target_result_id, revocation_event_id | 未到着の結果も参照可能。対象結果への即時FKを要求しない |
| local_result_exclusions | target_origin, target_result_id, active, reason, administrator, changed_at | ローカル除外。監査履歴を保持 |
| federation_inbox | origin, event_id, payload_hash, received_at, processing_state, error_code | origin+event_id一意。未投影・隔離を再処理可能 |
| federation_outbox | event_origin, event_id, destination_origin, attempts, next_attempt_at, lease_until, state | イベント+宛先一意。イベントと同一TXで追加 |
| participation_ticket_uses | issuer, jti, expires_at, actor_id, match_id | issuer+jti一意。一度だけ交換するための永続記録 |
| participation_sessions | session_hash, actor_id, match_id, expires_at, revoked_at | 生のセッショントークンを保存しない |
| ranking_projections | scope_key, actor_id, wins, total_score, participation_count, rank, generation | scope+actor一意。有効イベントから再生成可能 |
| ranking_projection_runs | scope_key, generation, computed_at, input_revision, state | 再計算世代と反映状況 |

問題改訂時は新しいquestion_idで問題と解答を登録し、既存行を変更しない。question_versionsとquestionVersionは固定参照の契約として保持し、新規問題の初期versionは1とする案。新問題を使う問題セットは新しいセット版で参照し、過去の結果・旧セットの参照は維持する。改訂元との専用の関連付けはMVPでは設けない。問題の不変内容とは別にquestion_availability（owner, question_id, retired_at）で新規出題停止を管理する案。改訂元を停止し、新規開始時に旧セット版からの参照も拒否する。待機中なら取消・更新済みセットへ再参加とし、開始済み試合の固定参照と過去結果は変更しない。

## 調整値の保存

ruleset_versions.configにchoiceCount、characterAnswerTimeMs、correctAnswersToWin、mistakesToDisqualify、revealIntervalMs、judgedDisplayMs、fullRevealWaitMsを保存し、rules_hashの対象にする。competitions.conditionsにplayersPerMatchと「接続中actorが1人以下なら30秒の復帰猶予後に無効、失格していない参加者が1人以下なら即無効」の成立条件を含める。matchesから参照する版は開始前に固定する。

初期定数の変更でDBの既存版を上書きしない。新しい値は新ルール版・大会定義へ適用する。開始前に固定choiceCount分の一意な候補を全問題で作れることを検証し、ダミー不足や重複候補を黙って減らして配信しない。

characterAnswerTimeMsの初期値は3000ms。終了理由には接続人数不足、失格による残存人数不足、7問先取、問題枯渇を区別して保存する。将来のルーム戦では試合種別と部屋設定を結果から追跡できるようにし、カジュアル戦を順位投影へ含めない契約を追加する。

## 制約とindex

- 版は正整数、回数・勝数・参加数は非負整数。得点合計は負数を許容する。期間・JSON設定・文字列長・上限を境界で検証し、DBでも可能な制約を課す。
- tenant相当のowner/hostを複合FKに含め、別インスタンスの同名IDと誤結合しない。
- 不変版は更新権限を制限し、必要なら更新拒否triggerで保護する。参照中の版はcascade削除しない。
- outboxに `(state,next_attempt_at)`、inboxに `(processing_state,received_at)`、試合に `(competition_id,finished_at)`、結果に対象result検索用indexを設ける。
- 同じIDでhashが違うものをON CONFLICTで上書きしない。一致確認ができた重複だけ成功扱いにする。
- DBロールはmigration用と通常API用を分離する。ブラウザーのanon/authenticatedに内部テーブル権限を付与しない。

## 保存トランザクション

開催元の確定保存は結果イベント、試合の保存状態、配送先別outboxを同一TXでcommitする。DO側の再試行では既存結果とhash一致を確認する。受信側はinboxとイベント原本を同一TXで保存し、永続受領後にACKする。投影更新は別ジョブでもよいが、未処理状態を永続化する。

## 順位の再生成

1. 将来のカジュアルなルーム戦はレート・ローカルおよび連合ランキングの全指標から除外する。検証済み確定イベントから、認定開催元・固定大会条件・期間・成立条件に合うものを抽出する。
2. 取消tombstoneとローカル除外を適用し、同一試合の置換結果を解決する。矛盾する複数結果は隔離する。
3. actorごとに勝数、総得点、参加数を集計する。有効試合の7問先取または問題枯渇による勝者に1勝。失格者は勝者にしない。問題枯渇時の正解数比較・引き分けと集計はspecification.mdの仮案を参照する。INVALIDは勝数・総得点・参加数のすべてから除外する。
4. wins降順、total_score降順だけでRANKを求める。actorIdは最終表示のORDER BYにのみ加え、同順位を崩さない。
5. 新世代の投影を作り、同一TXで参照世代を切り替える。途中計算をUIへ出さない。

入力の基準revisionを固定し、計算中に届いたイベントは次の再計算へ確実に回す。小規模MVPは対象大会を再計算する単純な方式を提案する。順位をイベント到着順に直接加減算することを唯一の正にしない。

## 2026-09-14：稼働中設定の参照

`quiz_game.matchmaking_settings` は `(owner, profile)` を主キー、`(owner, competition_id, competition_version)` を不変の大会版への外部キーとする。有効参照だけを切り替え、過去版は更新しない。RLSと権限をカタログ同様に設定し、quiz_game_readerはSELECTのみ、anon/authenticated/PUBLICはアクセス不可。migrationは202609140001_matchmaking_settings.sql。

設定反映は開催元単位のtransaction advisory lockで直列化し、ルールhash・大会条件が同じ版は再利用する。ルール版・大会版の追加と有効参照のupsertは同一TX。待機・進行中のDOは自身が保存した版を保持する。管理UIは1D。操作は[設定手順](configuration.md)。

## 2026-09-14：Drizzleをスキーマ管理の正へ変更

src/worker/db/schema.tsで既存8テーブルの列・制約・FK・RLSを定義。生成/カスタムmigrationはdrizzle/、適用履歴はdrizzle.__drizzle_migrationsへ統一。初期2件は実DBと照合して適用済み登録し、既存表を再作成していない。追加ロールquiz_game_configはカタログSELECT、ルール・大会・有効設定INSERT、有効設定UPDATEのみ。その他の書込・DDLは拒否。不変トリガーは維持。[DB管理](database.md)参照。
