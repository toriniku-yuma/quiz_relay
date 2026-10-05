import Spinner from '../components/Spinner';
import { useAuth } from '../features/auth/useAuth';
import Application from './Application';

export default function App() {
  const auth = useAuth();
  return (
    <>
      <Application key={auth.user?.id ?? 'guest'} auth={auth} />
      <div
        role="status"
        aria-hidden={auth.ready}
        className={`fixed inset-0 z-50 flex items-center justify-center bg-paper transition-opacity duration-300 motion-reduce:transition-none ${auth.ready ? 'pointer-events-none opacity-0' : 'opacity-100'}`}
      >
        <Spinner />
      </div>
    </>
  );
}
