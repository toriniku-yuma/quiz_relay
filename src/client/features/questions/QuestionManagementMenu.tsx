import {
  canOpenQuestionPage,
  questionHref,
  questionManagementGroups,
  questionPages,
} from './pages';

export default function QuestionManagementMenu({
  instanceId,
  permissions,
}: {
  instanceId: string;
  permissions: { administrator: boolean; review: boolean; manageAuthors: boolean };
}) {
  if (!canOpenQuestionPage('management', permissions))
    return <p role="alert">このページを利用する権限がありません。</p>;
  return (
    <nav aria-label="問題管理" className="grid gap-8">
      {questionManagementGroups.map((group) => {
        const pages = group.pages.filter((page) =>
          canOpenQuestionPage(page, permissions),
        );
        return pages.length > 0 ? (
          <section key={group.title} className="border-t border-line pt-4">
            <h2 className="mb-3 text-xl font-bold">{group.title}</h2>
            <ul className="grid gap-1">
              {pages.map((page) => (
                <li key={page}>
                  <a
                    className="block rounded px-3 py-3 underline hover:bg-paper"
                    href={questionHref(page, instanceId)}
                  >
                    {questionPages[page].title}
                  </a>
                </li>
              ))}
            </ul>
          </section>
        ) : null;
      })}
    </nav>
  );
}
