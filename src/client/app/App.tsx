import NotFoundPage from '../pages/NotFoundPage';
import { routes } from './routes';

export default function App() {
  const path = `${location.pathname.replace(/\/$/, '')}/`;
  const route = routes.find((candidate) => candidate.path === path);
  const Page = route && 'component' in route ? route.component : NotFoundPage;

  return <Page />;
}
