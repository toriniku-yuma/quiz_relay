import { createRoot } from 'react-dom/client';
import App from './app/App';
import { rootRedirect } from './app/redirect';
import './styles/global.css';

const redirect = rootRedirect(new URL(location.href));

if (redirect) {
  location.replace(redirect);
} else {
  const root = document.getElementById('root');
  if (!root) throw new Error('Root element is missing');

  createRoot(root).render(<App />);
}
