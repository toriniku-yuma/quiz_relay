# 開発ルール

[一覧](../README.md) ／ [機能別の実装計画](plan.md) ／ [検証](testing.md)

**変更する機能の仕様を読み、実装・画面・必要な検証を一緒に整えます。**
コミットの件名・本文は日本語。技術名や識別子は原表記で構いません。

## 文書と変更範囲

仕様・設計・手順は docs に置き、AGENTS.md は入口へのリンクだけにします。
セッション内で完結する調査結果・残タスク整理・途中経過は会話内で扱い、文書へ転記しません。文書の更新は、継続して参照する仕様・設計・手順や実装・検証状況が変わった場合、または利用者が明示的に記録を求めた場合に行います。
同じ説明は1か所にまとめ、変更は該当箇所を書き直します。日付付きの追記、作業段階の略号、再開プロンプトを積み重ねません。
最初に結論、次に操作や条件を書く。手順は番号、比較は表を使い、長い段落は意味のまとまりで分けます。

機能の範囲は[仕様](../spec/overview.md)、順序は[計画](plan.md)を参照します。
未実装・未検証は仕様の未決定と区別し、実施していない確認を完了扱いにしません。
変更した契約・手順も同じ変更で更新します。仕様の判断理由は[設計判断](../design/decisions.md)へ集約します。

既存機能と標準機能を優先し、将来のためだけの抽象化・依存・空フォルダーを増やしません。
報告は変更内容・検証結果・未実施事項を簡潔に。文書だけの変更ではリンクと整合性を確認します。

## 守るデータ境界

採点・認可はサーバーで行います。正解、未表示の問題本文、秘密鍵をフロントエンドへ渡しません。
ルール・問題・結果の過去版を上書きせず、migration・制約・index・権限をソース管理します。
本人の識別に表示名やメールの一致を使いません。

`.dev.vars`、`.env.supabase-admin`、`.wrangler` の秘密情報を表示・コミットしません。
一時QAスクリプトは内容を確認してから実行します。整理を理由に既存DB・DO・outboxの原本を消しません。

## ファイルの置き場所

| 配置 | 役割 |
| --- | --- |
| `src/client/main.tsx` | 起動と起動時リダイレクト |
| `src/client/app/` | ルート一覧・ページ選択・ナビゲーション |
| `src/client/pages/` | ページを組み立てる。API・認証処理を持たない |
| `src/client/components/` | Button・TextField・Panelなど共通UI |
| `src/client/features/` | auth・game・matchmaking・debugなど機能固有のUIと処理 |
| `src/client/styles/` | テーマと全体スタイル |
| `src/worker/index.ts`・`routes/` | HTTPルートと共通処理の登録 |
| `src/worker/game/`・`matchmaking/` | 対戦・待機列 |
| `src/worker/probes/` | 検証API・検証DO・DBプローブ |
| `src/worker/federation/` | 署名・正規化・送信先の検査 |
| `src/worker/env.ts` | Worker bindingの型 |
| `src/worker/db/`・`drizzle/` | Drizzleスキーマとmigration |
| `tests/`・`scripts/` | テストと実HTTP・DB検証 |

正式機能を probes に追加しません。機能が大きくなったときだけ、その中で routes・state・validation などに分けます。

### Reactコンポーネント

1つのTSXに1つのコンポーネント関数を置きます。起動専用の main.tsx はコンポーネントを定義しません。
イベントや map のインラインコールバックは使えます。通信・認証・状態制御はTSやhookへ分離します。
ボタンや入力欄など繰り返すUIは共通部品を使い、機能専用のまとまりは features に置きます。
長いクラス列を隠すだけのラッパーは作りません。

### ルートと画面移動

ルート一覧はパスとコンポーネント・転送先の宣言に限定します。認証・API・URL変更の副作用を混ぜません。
AppがページとNotFoundを選び、redirect.tsが転送URLを作り、mainが実際に転送します。
認証コールバックは features/auth/callback、共有パスは paths.ts に置き、ページの相互importを避けます。専用ルーター依存は追加しません。

`/` は `/game/` へ query・hashを保持して転送します。正式参加は `/game/`、開発参加は `/local-game/`、技術検証は `/debug/`。
正式ホームを作るときにトップ転送を外します。Supabase Authの戻り先設定を不要に増やしません。

app/navigation.tsが通常の同一タブ内クリックとHistory APIを扱います。
外部・API・修飾キー・download・別タブ指定はブラウザーの動作を維持します。
Applicationが共通認証・組織情報・メニューを保持し、移動でMatchPageを破棄しません。
OrganizationGatewayは閲覧先と対戦接続先を分け、開始済み試合の接続先を維持します。自動マッチの待機は画面移動で取り消し、応答不明の参加操作も同じ操作IDで取消を確認します。
スマートフォンのメニューは標準dialogを使い、フォーカスとEscape操作を保ちます。

Workerのルートも method・path・middleware・handler の登録だけにします。
probes は routes・authorize・handlers に分け、共通HTTP応答は http/handlers に置きます。
Honoの型付きhandlerとmiddlewareの順序・適用範囲を維持します。関連handlerは同じファイルでよく、1関数1ファイルや汎用dispatcherは不要です。

APIの完全なパスは `src/shared/api-paths.ts` の `API_PATHS` をクライアント・Worker・CLIで共有します。
画面パスとは分け、React・Hono・環境変数・秘密への依存を持たせません。
probeのprefixはmiddlewareに使い、完全パスのrouteはルートへmountします。変更時は全呼出元を確認します。
契約テストの期待URLは、同じ誤りを共有しないよう文字列で書いて構いません。

## 見た目と入力の実装

React・TypeScript・Tailwind CSSを使います。色・文字・余白はテーマへ集約し、TSXでは標準utilityとテーマ値を優先します。
固定の色値や任意値を増やさず、標準値で表せない理由がある場合だけ独自CSS・任意値を使います。
状態は型付きpropsと完全なクラス文字列の対応表で表し、クラスの断片を文字列連結しません。
連続的な進捗など実行時の値はCSS変数やstyleへ渡します。

`global.css` はimport・`@theme`・body・リンク・フォーカス等の全体設定に限定します。
Preflightと重複するresetや部品ごとのCSS・media queryを蓄積しません。
キーボード操作・フォーカス・適切なHTML要素を維持します。テーマと効果音の見た目は[概要](../spec/overview.md)に従います。

隣接するボタン・入力欄・テーブル・メニュー項目が接しないよう、まとまりにはflex／gridのgapを設定し、別のまとまりとの間にも余白を設けます。通常表示だけでなく、待機・結果・エラー・狭い画面でもgap抜けがないことを確認します。

### クラスの結合

`src/client/lib/cn.ts` の `cn()` は clsx 2.1.1 と tailwind-merge 3.6.0 を使います。
共通部品では「基本 → バリエーション → 外部className」の順。固定文字列だけなら cn は不要です。
Tailwind 4.3のテーマ・任意値・状態修飾子に対する競合を検証します。

`shadow-button`・`shadow-button-pressed` は extendTailwindMerge のshadowテーマへ登録します。
追加・改名時は登録と、通常／状態付きの上書き・影色との共存テストを更新します。
現在の色トークンに追加設定は不要です。独自utilityを加えるときは競合分類を確認します。
バリアント管理ライブラリは実際に必要になるまで導入しません。

### 入力欄と説明

文字・数値入力には短い入力例をplaceholderとして置きます。メール例は example.com を使い、秘密や実データを例にしません。
ラベル・必須条件・形式は入力後も読めるようにします。例示を value・defaultValue に設定せず、保存済み値や意味のある初期値は維持します。
checkboxなど適用できない入力は対象外です。

用途が分かりにくい設定には、目的・必要な場面・入力情報の入手先・確認と保存の違いを短く説明します。
権限取消などの影響範囲は保存前に示します。

### 効果音

基本効果音を同梱して初期割当し、イベントと音源の対応は1か所で管理します。開発者向けの差替え手順を用意し、利用者にはオン・オフと音量を提供します。
素材の選定・割当はユーザーが行い、初期状態は無音です。
未設定・再生失敗でも進行し、音の完了を入力送信や対戦進行の条件にしません。ブラウザーの再生制限、ミュート、無音時の視覚表示に対応します。

## 整形と検証

Biome 2.5.12に統一します。Prettierは追加しません。

| コマンド | 用途 |
| --- | --- |
| `pnpm run format` | 整形 |
| `pnpm run format:check` | 整形の確認 |
| `pnpm run lint` | 整形・推奨Lint・import整理 |
| `pnpm run check` | Lint・型検査・テスト・ビルド |

対象は src・tests・scripts・config、ルートのTS/JSON/JSONC/index.html。gitignoreを尊重し、秘密・生成物・Markdown・YAML・SQLは対象外です。
Tailwind v4対応とHTMLの実験的対応を使い、推奨Lintの警告も失敗扱いにします。
安全な修正は check --write を使い、unsafe修正を無差別適用しません。tscと1TSX1コンポーネントの確認は別に必要です。
テストは公開関数を直接importし、TSX文字列を切り出して実行しません。

空行は準備・検証・処理・返却、hook・派生値・イベント・JSXのまとまりを区切るために使います。
テストも準備・実行・確認とケースの境界で区切ります。関連定数・guard・assertはまとめ、連続空行や全行の分断は避けます。
コメントは対象の近くに置き、空行のために関数・依存を増やしません。

## DBと設定

Drizzleの型付きAPIとDrizzle Kitを使い、`src/worker/db/schema.ts` を正とします。
手書きSQLは未対応の権限・trigger等のcustom migrationと必要なsql式だけに限定します。
文字列連結・独自escape・Management APIへの通常SQL送信はしません。reader・writer・migrationの権限を分け、CLIのTSも型検査します。

人数・ルール・問題セットのJSON入力はDBの不変版へ反映し、新規参加の有効版を切り替えます。
接続・待機の運用値は `config/runtime.json`。[設定手順](../guides/configuration.md)と[DB管理](../guides/database.md)を参照してください。
初期問題は `supabase/seeds/mock-hiragana.json`、テスト用は `tests/fixtures/questions.ts` に置き、srcからimportしません。
新規試合の問題はDBから取得します。pnpm installではPostgres.jsの接続終了パッチも適用します。

## デプロイと既存環境の変更

Workersへのデプロイは、明示的な依頼、またはサーバー実環境が必要な検証に限ります。
デザイン・通常操作は `pnpm dev` で確認します。Cloudflare固有の挙動・binding・公開origin認証を確認する場合は、実環境が必要な理由を先に伝えます。
この条件を満たす検証で、デプロイのためだけの再確認は挟みません。既存の無料範囲と `PROBES_ENABLED=true` の指定を維持します。

実装と既存DBの移行・クラウド配置は別の作業です。対象・差分・検証・バックアップ・復旧手順を揃え、会話で許可された範囲内で実行します。
