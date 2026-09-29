import UsersPanel from '../features/moderation/UsersPanel';
export default function UsersPage() {
  return (
    <main className="mx-auto max-w-5xl p-4 md:p-8">
      <h1 tabIndex={-1} className="mb-6 text-3xl font-bold outline-none">
        ユーザー管理
      </h1>
      <UsersPanel />
    </main>
  );
}
