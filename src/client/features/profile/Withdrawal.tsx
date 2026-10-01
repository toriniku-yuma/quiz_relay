import { useApp } from '../../app/context';
import Button from '../../components/Button';
import TextField from '../../components/TextField';
import { useWithdrawal } from './useWithdrawal';

export default function Withdrawal() {
  const { auth, matchStatus } = useApp();
  const withdrawal = useWithdrawal(auth.user?.id);
  const playing = !!matchStatus?.roomId && !matchStatus.finished;
  return (
    <section className="grid gap-4">
      {withdrawal.accepted ? (
        <>
          <p role="status">退会を受け付けました。アカウントの利用を停止しました。</p>
          <p>
            {withdrawal.ready
              ? '認証情報の削除が完了しました。新規アカウントとして再登録できます。'
              : '再登録の準備中です。認証情報の削除は自動で再試行します。'}
          </p>
        </>
      ) : (
        <>
          <p>
            退会するとすぐに利用できなくなり、プロフィール・本人の履歴・ランキングが非表示になります。
          </p>
          <p>
            投稿問題と対戦相手の試合結果は残り、名前は「退会ユーザー」になります。相手の勝敗・レートは変わりません。
          </p>
          <p>
            認証情報の削除完了後は、同じメールアドレス・Googleアカウントで新規登録できます。以前の戦績・管理権限・作問者資格・投稿の所有権は引き継ぎません。個人情報は30日以内に削除します。
          </p>
          <p>
            対戦待機中は先に待機を取り消してください。試合中は終了まで退会できません。組織に管理者が自分だけの場合は、先に管理者の引き継ぎを完了してください。
          </p>
          {!auth.user && !withdrawal.locked ? (
            <p>ログインしてから退会手続きをしてください。</p>
          ) : (
            <form
              className="grid gap-4"
              onSubmit={(event) => {
                event.preventDefault();
                void withdrawal.submit();
              }}
            >
              <TextField
                id="withdrawal-confirmation"
                label="確認のため「退会」と入力してください"
                placeholder="退会"
                value={withdrawal.confirmation}
                disabled={withdrawal.busy || withdrawal.locked}
                onChange={(event) => withdrawal.setConfirmation(event.target.value)}
              />
              <Button
                type="submit"
                disabled={
                  withdrawal.busy || withdrawal.confirmation !== '退会' || playing
                }
              >
                {withdrawal.busy
                  ? '処理中…'
                  : withdrawal.locked
                    ? '同じ内容で再試行'
                    : '退会する'}
              </Button>
            </form>
          )}
          {playing && (
            <p role="status">
              参加中の対戦から戻り、待機取消または試合終了後に実行してください。
            </p>
          )}
        </>
      )}
      {withdrawal.error && <p role="alert">{withdrawal.error}</p>}
      <a href="/account/" className="underline">
        マイページへ戻る
      </a>
    </section>
  );
}
