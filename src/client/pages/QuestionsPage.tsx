import { useApp } from '../app/context';
import { ROOMS_PATH } from '../app/paths';
import Button from '../components/Button';
import { questionPage, questionPages } from '../features/questions/pages';
import QuestionManagementMenu from '../features/questions/QuestionManagementMenu';
import QuestionWorkspace from '../features/questions/QuestionWorkspace';

export default function QuestionsPage() {
  const { auth, organization, url } = useApp();
  const page = questionPage(url.pathname);
  const instanceId = url.searchParams.get('instance') ?? '';
  const instance = organization.data?.instances.find((item) => item.id === instanceId);
  const loading =
    !auth.ready || (!!auth.user && !organization.data && !organization.error);
  return (
    <main className="mx-auto max-w-5xl p-4 md:p-8">
      <h1 tabIndex={-1} className="mb-4 text-3xl font-bold outline-none">
        {questionPages[page].title}
      </h1>
      {instance && <p className="mb-6">{instance.name}</p>}
      {auth.user && (
        <a
          className="mb-4 block text-sm underline"
          href={`${ROOMS_PATH}?instance=${instanceId}&view=sets`}
        >
          部屋用の自分の問題セット
        </a>
      )}
      {loading ? (
        <p role="status">ログイン状態とインスタンスを確認しています。</p>
      ) : organization.error && !organization.data ? (
        <div>
          <p role="alert">{organization.error}</p>
          {organization.loadFailed && (
            <Button disabled={organization.busy} onClick={organization.refresh}>
              再試行
            </Button>
          )}
        </div>
      ) : !auth.user ? (
        <p>メニューからログインしてください。</p>
      ) : instance && page === 'management' ? (
        <QuestionManagementMenu
          instanceId={instanceId}
          permissions={{
            administrator: organization.data?.account?.administrator === true,
            review: instance.permissions.includes('questions'),
            manageAuthors: instance.permissions.includes('authors'),
          }}
        />
      ) : instance ? (
        <QuestionWorkspace
          key={`${instanceId}:${url.pathname}:${url.searchParams.get('id') ?? ''}`}
          instanceId={instanceId}
          page={page}
          selectedId={url.searchParams.get('id')}
          search={url.search}
        />
      ) : (
        <p>インスタンス一覧から対象を選択してください。</p>
      )}
    </main>
  );
}
