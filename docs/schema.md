# データ設計（論理スキーマ案）

実際のSQL migrationは未作成。以下を実装時に制約・index・権限まで落とし込み、空DBと既存DBの両方で検証する。

## 公開境界

内部テーブルは非公開スキーマへ配置する。ブラウザー向けには必要最小限のAPI・viewだけを公開し、問題本文の未表示部分、許容解答、入力解答、配送原本を公開しない。署名秘密鍵はDBテーブルに保存せずWorker secretsで管理する。

| テーブル | 主な属性・キー | 制約・用途 |
| --- | --- | --- |
| instances | id, origin | 正規化origin一意 |
| instance_keys | instance_id, kid, public_key, valid_from, valid_until, status | instance+kid一意。旧鍵履歴を保持 |
| peers | instance_id, approval_state, approved_at | pending/approved/suspended/rejected。承認履歴を別途保持 |
| actors | actor_id, home_origin, subject, display_name | home_origin+subject一意。表示名は非一意 |
| ruleset_versions | owner, ruleset_id, version, rules_hash, config | owner+id+version一意。過去版不変 |
| question_versions | owner, question_id, version, body, explanation, source, permission | owner+id+version一意。修正は追加 |
| question_answers | owner, question_id, version, accepted_answers, panel_readings, distractors | 問題版へのFK。表示用正答とパネル用カタカナ読みを分離。ダミー候補を含め非公開 |
| question_sets | owner, set_id, version, manifest_hash, permission | owner+id+version一意 |
| question_set_items | owner, set_id, set_version, ordinal, question_owner, question_id, question_version | セット版と問題版へのFK。セット内ordinal一意 |
| competitions | owner, competition_id, definition_version, rules_hash, scoring_version, start_at, end_at, conditions | 開始後は定義不変。start_at < end_at |
| competition_hosts | competition識別子, host_origin | 認定開催元。固定大会定義の一部 |
| matches | host_origin, match_id, competition識別子, 固定版, started_at, finished_at, status, invalid_reason | INVALIDは集計対象外。host+match_id一意。結果から固定条件を追跡可能 |
| participants | host_origin, match_id, actor_id, joined_at | 試合+actor一意。再接続で追加しない |
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

## 調整値の保存

ruleset_versions.configにchoiceCount、answerTimeMs、revealIntervalMs、judgedDisplayMs、fullRevealWaitMsを保存し、rules_hashの対象にする。competitions.conditionsにplayersPerMatchと「接続中actorが1人以下なら猶予なく無効」の成立条件を含める。matchesから参照する版は開始前に固定する。

初期定数の変更でDBの既存版を上書きしない。新しい値は新ルール版・大会定義へ適用する。開始前に固定choiceCount分の一意な候補を全問題で作れることを検証し、ダミー不足や重複候補を黙って減らして配信しない。

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

1. 検証済み確定イベントから、認定開催元・固定大会条件・期間・成立条件に合うものを抽出する。
2. 取消tombstoneとローカル除外を適用し、同一試合の置換結果を解決する。矛盾する複数結果は隔離する。
3. actorごとに勝数、総得点、参加数を集計する。有効試合の同点優勝者は各1勝。INVALIDは勝数・総得点・参加数のすべてから除外する。
4. wins降順、total_score降順だけでRANKを求める。actorIdは最終表示のORDER BYにのみ加え、同順位を崩さない。
5. 新世代の投影を作り、同一TXで参照世代を切り替える。途中計算をUIへ出さない。

入力の基準revisionを固定し、計算中に届いたイベントは次の再計算へ確実に回す。小規模MVPは対象大会を再計算する単純な方式を提案する。順位をイベント到着順に直接加減算することを唯一の正にしない。
