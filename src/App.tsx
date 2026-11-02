import { Activity, BookOpen, Crosshair, Home, LineChart, Settings, ShieldCheck, Swords, type LucideIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { currentAccount, useSyncStatus } from './backend/account';
import { ErrorBoundary } from './components/ErrorBoundary';
import { applyPrefs, usePrefs } from './lib/prefs';
import { store } from './lib/store';
import { AdminPage } from './pages/AdminPage';
import { HomePage } from './pages/HomePage';
import { LearnPage } from './pages/LearnPage';
import { PlayPage } from './pages/PlayPage';
import { PrivacyPage } from './pages/PrivacyPage';
import { ProgressPage } from './pages/ProgressPage';
import { ReviewPage } from './pages/ReviewPage';
import { SettingsPage } from './pages/SettingsPage';
import { TrainPage } from './pages/TrainPage';

const NAV: { href: string; label: string; section: string; icon: LucideIcon }[] = [
  { href: '#/', label: 'Home', section: '', icon: Home },
  { href: '#/play', label: 'Play', section: 'play', icon: Swords },
  { href: '#/train', label: 'Train', section: 'train', icon: Crosshair },
  { href: '#/learn', label: 'Learn', section: 'learn', icon: BookOpen },
  { href: '#/review', label: 'Review', section: 'review', icon: LineChart },
  { href: '#/progress', label: 'Progress', section: 'progress', icon: Activity },
  { href: '#/settings', label: 'Settings', section: 'settings', icon: Settings },
];

function useRoute() {
  const [hash, setHash] = useState(window.location.hash);
  useEffect(() => {
    const onChange = () => {
      setHash(window.location.hash);
      window.scrollTo(0, 0);
      document.getElementById('main')?.focus({ preventScroll: true });
    };
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return hash.replace(/^#\/?/, '').split('/');
}

export function App() {
  const [section, param, detail] = useRoute();
  const prefs = usePrefs();
  useEffect(() => applyPrefs(prefs), [prefs]);
  const [storageError, setStorageError] = useState<string | null>(store.lastError);
  useEffect(() => store.onError(setStorageError), []);
  const syncStatus = useSyncStatus();
  const account = currentAccount();

  useEffect(() => {
    const titles: Record<string, string> = { play: 'Play', train: 'Train', learn: 'Learn', review: 'Review', progress: 'Progress', settings: 'Settings', admin: 'Admin', privacy: 'Privacy' };
    document.title = Object.hasOwn(titles, section) ? `${titles[section]} · GridTheory` : 'GridTheory';
  }, [section]);

  return (
    <div className="app">
      <a className="skip-link" href="#main" onClick={(event) => { event.preventDefault(); document.getElementById('main')?.focus(); }}>
        Skip to content
      </a>
      <header className="sidebar">
        <a href="#/" className="brand" aria-label="GridTheory home">
          <span className="brand-mark" aria-hidden="true">
            <span /><span /><span /><span />
          </span>
          <span className="brand-name">GridTheory</span>
        </a>
        <nav aria-label="Main">
          {NAV.map((item) => (
            <a key={item.href} href={item.href} className="nav-link" aria-current={section === item.section ? 'page' : undefined}>
              <item.icon size={20} aria-hidden="true" />
              <span>{item.label}</span>
            </a>
          ))}
          {account?.admin && (
            <a href="#/admin" className="nav-link" aria-current={section === 'admin' ? 'page' : undefined}>
              <ShieldCheck size={20} aria-hidden="true" />
              <span>Admin</span>
            </a>
          )}
        </nav>
      </header>
      <main id="main" tabIndex={-1}>
        {storageError && (
          <p className="storage-warning" role="alert">
            Your browser couldn't save your latest changes, possibly because its storage is full. Download a backup from Settings, and don't clear this site's data.
          </p>
        )}
        {syncStatus === 'full' && (
          <p className="storage-warning" role="alert">
            Your account has reached its storage limit, so new changes aren't syncing to your other devices. They're still saved here. Delete some old games to make room.
          </p>
        )}
        {syncStatus === 'denied' && (
          <p className="storage-warning" role="alert">
            Your changes couldn't be synced because your access has changed. Reload the page, or sign in again.
          </p>
        )}
        <ErrorBoundary key={section}>
        {section === 'play' ? (
          <PlayPage />
        ) : section === 'train' ? (
          <TrainPage key={param ?? 'scenarios'} view={param} detail={detail} />
        ) : section === 'learn' ? (
          <LearnPage key={param ?? 'index'} lessonId={param} />
        ) : section === 'review' ? (
          <ReviewPage key={param ?? 'index'} gameId={param} />
        ) : section === 'progress' ? (
          <ProgressPage />
        ) : section === 'settings' ? (
          <SettingsPage />
        ) : section === 'admin' ? (
          <AdminPage />
        ) : section === 'privacy' ? (
          <PrivacyPage />
        ) : (
          <HomePage />
        )}
        </ErrorBoundary>
      </main>
    </div>
  );
}
