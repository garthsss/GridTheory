import { Download } from 'lucide-react';
import { useEffect, useState } from 'react';

interface InstallEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

// The browser fires this once, often before the Settings page is open, so it's caught at startup.
let deferred: InstallEvent | null = null;
const listeners = new Set<() => void>();
if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferred = event as InstallEvent;
    listeners.forEach((listener) => listener());
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    listeners.forEach((listener) => listener());
  });
}

/** Installs GridTheory as an app, where the browser offers it. */
export function InstallButton() {
  const [, refresh] = useState(0);
  useEffect(() => {
    const listener = () => refresh((n) => n + 1);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  const installed = window.matchMedia?.('(display-mode: standalone)').matches;
  if (installed) return <p className="small">GridTheory is running as an installed app.</p>;
  if (!deferred) {
    return <p className="small muted">Your browser hasn't offered installation here. In Chrome or Edge, look for the install icon in the address bar. On iPhone, use Share, then Add to Home Screen.</p>;
  }
  return (
    <button
      type="button"
      className="btn btn-primary"
      onClick={() => {
        const event = deferred;
        event?.prompt();
        void event?.userChoice.then(() => {
          deferred = null;
          refresh((n) => n + 1);
        });
      }}
    >
      <Download size={16} aria-hidden="true" />Install GridTheory
    </button>
  );
}
