import { useAuth } from '../features/auth/useAuth';
import Application from './Application';

export default function App() {
  const auth = useAuth();
  return <Application key={auth.user?.id ?? 'guest'} auth={auth} />;
}
