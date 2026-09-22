# 2026-09-18 環境初期化の実行記録

## 最新の結論：クラウド初期化は取りやめ

ユーザーの後続指示により、Supabaseの認証情報を保持し、[ローカルPostgreSQL環境](local-postgres.md)を用意する方針へ変更した。SupabaseのDB・Authユーザー、Cloudflareの配信・DOは削除／変更していない。下記の承認・停止は過去の経緯であり、再開待ちの作業ではない。取得済みバックアップはGit除外領域に保持する。

## 承認された範囲

ユーザーはSupabaseの問題・戦績・設定・組織情報・Authユーザー削除と現行コード用の空DB構造、Cloudflareの待機列・部屋・対戦セッションの初期化を承認。プロジェクト、URL、OAuth・接続設定、ローカルコードと未コミット変更を保持し、削除前にバックアップを取得する。

## 対象と読取結果

- Supabase：quiz_relay（ixjodssvkhrmfwschtxd、ap-northeast-2）。PostgreSQL 17.6、Authユーザー5件、Storageオブジェクト0件。
- Cloudflare：quiz-relay-probe。Probe／GameRoom／Matchmakerの3つのSQLite Durable Object namespace。
- 元の配信version：b35b5779-c36a-4c92-8f66-cb15801c67fa（100%）。リセット作業時点の実配信設定を保存。ローカルwrangler設定との差があるため、ローカル設定で一括上書きしない。

## 取得済みバックアップ

Git除外済み `.wrangler/reset-20260918/` に保存。認証データや秘密を含むため、公開・コミットしない。

- database.dump：quiz_game、quiz_probe、drizzle、auth、storageのcustom形式dump（245233 bytes）。pg_restore --listで読取可能であり、auth.usersと問題データの収録を確認。復元実行は未実施。
- worker-content.bin／worker-content-type.txt：既存Workerコードのmultipartバックアップ。
- cloudflare.json：配信履歴・binding・namespace設定。
- supabase-auth-config.json／supabase-api-keys.json：既存Auth設定・管理用キー情報。内容をログへ表示していない。

バックアップ取得時点では通常サービスが動作中。削除を再開する場合、書込み停止後にDBバックアップを再取得し、DO状態も退避する。現時点でDOの内容のバックアップは未取得。

## 停止理由・実行状況

自動承認レビューが、対象Workerを一時的にメンテナンス版へ切り替える操作を拒否した。理由は、リセット自体は承認されているが、具体的な本番デプロイ・サービス停止・設定変更の明示承認と、元設定の保持根拠が不足しているため。

**DB・Authユーザー・DOの削除は未実行。メンテナンス版のデプロイも未実行。** Cloudflareが通常稼働のままDBだけを先に削除していない。Dockerは使用していない。

再開には作業中のメンテナンス切替・一時停止についてユーザー確認が必要。承認後、元配信versionとbinding／静的アセット／秘密設定の保持・復帰方法を照合してから切替える。DOのバックアップ・消去、DB／Authの初期化と検証を行い、元の配信版へ戻して一時管理経路が残らないことを確認する。初期化範囲の承認を改めて取り直す必要はない。
