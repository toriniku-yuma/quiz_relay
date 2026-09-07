# セルフデプロイ手順案

**未実行の初期手順です。** リポジトリにはアプリ・migration・Wrangler設定がまだなく、この文書だけではデプロイできません。実装で確定したコマンド、版、実行結果を後から追記します。

## MVPの定義

各運営者が自分のCloudflareアカウントとSupabaseプロジェクトへ配置できること。Docker一発起動やVPS対応は追加範囲。A/Bは異なるWorker、DO namespace、DB、Auth、署名鍵、originを使い、独立管理を検証する。

## 準備するもの

Cloudflare・Supabaseの利用権限、公開HTTPS origin、Node.js、パッケージマネージャー、Wrangler、SQL適用手段、ログイン方式に必要なメール/OAuth設定。版は初期実装で固定する。サービスの費用は契約と使用量に依存し、無料維持を保証しない。

## 設定案

| 設定 | 公開可否・用途 |
| --- | --- |
| INSTANCE_ORIGIN | 公開。署名issuer/audienceと一致 |
| SUPABASE_URL | 公開可能。所属元プロジェクト |
| SUPABASE_PUBLISHABLE_KEY | 公開可能なキー。RLS/grantsを必ず適用 |
| DATABASE_URL | secret。transaction poolerへの最小権限接続 |
| INSTANCE_SIGNING_PRIVATE_KEY | secret。インスタンス固有、ログ禁止 |
| INSTANCE_SIGNING_KID | 公開。pinする公開鍵と対応 |
| ROOMS | WranglerのDO binding名案 |

環境変数名は提案。公開用Vite変数へsecretを置かない。Supabase管理用資格情報は必要な管理工程にだけ使用し、通常処理へ安易に流用しない。

## 手順

1. リポジトリを取得し、固定したNode・依存関係をlockfileから導入する。
2. 独立したSupabaseプロジェクトを作成し、DBリージョン、接続先、Auth設定を確認する。
3. migration、index、grants、RLS、通常API用DBロールを適用する。空DBでの適用結果を記録する。
4. Supabase Authのredirect URL、メールのマジックリンク用配信と、Google OAuthを設定する。各所属インスタンスのAuthに対応したGoogle側の認証設定とredirect URLを用意する。具体的な設定手順は実装時に公式資料を確認して追記する。管理者のAuth subjectへサーバー側で管理権限を付与する。誰でも初期管理者になれる公開APIは作らない。
5. WranglerでWorker名、compatibility_date、必要なnodejs_compat、DO bindingとmigrationを設定する。既存DOデータを失う変更は避ける。
6. instance origin、所属Auth設定、DB接続、固有署名鍵を登録する。秘密はsecret機能を利用し、履歴・公開設定へ残さない。
7. Tailwind CSSのVite連携を含むUIとWorkerをビルドしてデプロイする。生成CSSが配信され、本番ビルドで状態別のスタイルが欠落しないことを確認する。UI/APIの同一origin配置を初期案とし、静的アセット、SPA fallback、API・WebSocketルーティングを確認する。
8. health、所属ログイン、管理権限、DO永続化、DB保存、配送ジョブ起動を確認する。healthは秘密を返さない。
9. Bにも別のアカウント／プロジェクト・鍵・DB・Authで同じ手順を適用する。
10. A/B管理者がorigin・公開鍵fingerprint・kidを確認して相互承認する。許諾済み問題セットと同一大会定義を配置する。
11. B所属からAへのチケット交換・対戦・結果保存・Bの順位反映を検証する。停止復旧と再送は[検証計画](verification.md)に従う。

## 更新・復旧

更新前にDB、DO永続状態、鍵・設定の復旧手段を確認する。DB schemaとprotocolの互換性を保って段階適用し、破壊的変更は別手順とする。アプリのロールバックだけでDB migrationが戻るとは扱わない。

公開前に人数・インスタンス上限、保持期間、バックアップ・復元手順、費用と監視を確定する。実行記録にはOS、Node、依存lock、Wrangler、compatibility_date、migration版、A/Bの構成、成功・失敗と復旧結果を残す。URLと設定を公開する際も秘密を除く。
