# ADR 0006：0A・0Bの検証基盤

日付：2026-09-08。状態：ローカル検証基盤に採用。クラウド接続・Auth遷移・本番連合契約は未確定。

## 決定と理由

- 検証機のNode 26.8.1 / pnpm 10.28.2（2026-09-09にユーザー指定でnpmから移行）と依存の実版を固定する。Nodeの長期運用版選定は運用受入時に再評価する。
- `src/client` にReact/TypeScript/Tailwind、`src/worker` にHono/DOを置く。Cloudflare Vite pluginで同一originの画面とWorkerを開発・ビルドする。検証段階で共通パッケージやゲーム本体の空構造は作らない。
- DOはSQLite-backed storageとHibernation WebSocket APIを使う。検証値はstorageから読み、カウンター更新とAlarm設定をtransactionで保存する。ローカルの再起動復元とAlarmを確認したが、クラウドHibernationは別途検証する。
- Workers内の実行互換性を検証するため、公式Vitest pluginを使う。暗号とDOはNodeだけのテストで代用しない。
- Postgres.js 3.4.9のprepared statements無効、TLSホスト検証有効でSupavisorへ接続する候補を実装する。検証用DBロールはDDL権限を持たない。実接続の成功は未記録。
- JWSはjose 6.2.12、JCSはcanonicalize 4.0.0を利用し、SHA-256はWeb Cryptoを使う。Node→WorkersとWorkers→Nodeの検証に成功。独自暗号アルゴリズムは作らない。

## 検証用の署名プロファイル

`messageType: probe` の検証専用メッセージのみを受け付ける。通常のinboxへ接続するコードではない。

- protected headerは `alg: EdDSA`, `kid`, `typ: quiz-relay-delivery+jws` だけを認める。呼出元がpin済み公開鍵とkidを渡す。キーの自動取得はしない。
- このプロファイルではprotected headerとpayloadのJSONにJCSと完全一致する表現を要求する。一般のJWSより厳しい制約であり、重複キーも拒否する。bodyHashはbodyのJCS UTF-8/SHA-256/base64url。
- compact JWS全体の上限256KiB、JSONの深さ32・検査ノード10000、有限数・正しいUnicodeのみ。問題セット2MiB用の配送はまだ対象外。
- 配送TTL最大60秒、時計許容差5秒、`now >= expiresAt + 5` で期限切れ。issuer/audience/method/path/用途/版/hashを検査後、nonceの原子的消費を呼び出す。
- nonce消費の実装を呼出元に要求し、`expiresAt + 5` まで保持する。現在の再送テストはメモリ上の集合で行い、本番用の永続消費は未実装。自己検証APIは毎回生成するメッセージを1回だけ検証する。

## 送信先と公開境界

検証APIは既定無効、明示有効化と32文字以上の専用トークンを要求する。Originがあれば同一originだけを認め、レスポンスをno-storeとする。例外の詳細や接続文字列を返さない。無認証healthは秘密を含めない。

WorkersのRequestは `redirect: error` を受け付けなかったため、`manual` と3xx拒否を採用する。HTTPS・承認origin完全一致・固定path・IP表記拒否は検証済み。DNS解決先の固定・再束縛対策は未検証で、送信関数はまだ設けない。

## 代替案と影響

別々のNodeサーバーで開発するとDOの互換性を後回しにするため、公式のローカルWorkers runtimeを使う。自作のJWS/JCS、汎用ORM、独自テストランナーは追加しない。既存のゲーム・連合仕様をこの検証のために変更しない。

## 参照した公式資料

- [Cloudflare Vite plugin](https://developers.cloudflare.com/workers/vite-plugin/get-started/)
- [Durable Objectsのテスト](https://developers.cloudflare.com/durable-objects/examples/testing-with-durable-objects/)
- [SupabaseのPostgres.js接続](https://supabase.com/docs/guides/database/postgres-js)
- [prepared statements無効化](https://supabase.com/docs/guides/troubleshooting/disabling-prepared-statements-qL8lEL)
- [jose](https://github.com/panva/jose)、[canonicalize](https://github.com/erdtman/canonicalize)
- [Supabase PKCE](https://supabase.com/docs/guides/auth/sessions/pkce-flow)

資料確認日：2026-09-08。実行条件・結果は[検証記録](../verification-results.md)を参照。

## 2026-09-09：実環境DB検証の追記

Cloudflare上のDB直接接続が失敗したため、無料Hyperdrive経由を採用し、実DBのcommit/rollback成功を確認した。DB接続先はSupavisor session pooler、CA検証はverify-full、キャッシュ無効、接続上限5。Vite本番ビルドだけHYPERDRIVE bindingを追加する。ローカルはCA付きTransaction pooler直接接続を維持する。資格情報はクラウドではHyperdriveへ集約し、Workerの重複Secretを削除した。詳細と残件は検証記録を参照する。
## 2026-09-10：0A完了と0Bの限定送信経路

0Aは実環境DB、DO保存・Alarm・WebSocket休止復帰、メールおよびGoogleの実認証結果がそろい完了。0Bは詳細契約へ広げないという今回の範囲整理により、署名プロファイルと承認workers.dev限定の送信技術基盤で区切る。元の詳細契約ゲートを満たした意味ではない。

検証用DNSドメインはユーザー未所有。購入せず、初期peerを手動承認したworker.account.workers.devの完全一致へ制限する。独自DNSを扱う拡張は別途実測が必要。global_fetch_strictly_public、固定path、manual redirectと3xx拒否を採用。固定の自Workerに公開ダミー本文を送るクラウド疎通が成功した。独立したA/B配送・一般のDNS rebinding・本番nonceや認可は未検証。

詳細な後続ゲートと制約はverification.md、security.md、検証記録を参照する。
