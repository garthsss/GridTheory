import '@fontsource-variable/bricolage-grotesque';
import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-sans/600.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import { StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { loadAccess, startAccount } from './backend/account';
import { AuthGate } from './pages/AuthGate';
import { applyPrefs, loadPrefs } from './lib/prefs';
import { openStore } from './lib/store';
import './styles.css';

const render = (page: ReactNode) => {
  applyPrefs(loadPrefs());
  createRoot(document.getElementById('root')!).render(<StrictMode>{page}</StrictMode>);
};

void loadAccess().then(async (access) => {
  if (access.state === 'local') {
    await openStore();
    render(<App />);
  } else if (access.state === 'ready') {
    await startAccount(access.userId);
    render(<App />);
  } else {
    render(<AuthGate access={access} />);
  }
});
