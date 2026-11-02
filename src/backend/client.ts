import { createClient } from '@supabase/supabase-js';

// These two values are public by design and end up in the app's code. The database's own rules are what protect the data.
// The service role key must never appear here, or in any VITE_ variable. The build fails if it does.
const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

/** With no backend configured, the app runs as before: local only, with no gate. Used for development and tests. */
export const backendEnabled = Boolean(url && key);

// Read before the client takes the login details out of the address, which it does as soon as it's created.
const linkParams = new URLSearchParams(window.location.hash.replace(/^#/, ''));
export const linkType = linkParams.get('type');
export const linkError = linkParams.get('error_description');
if (linkError) window.history.replaceState(null, '', window.location.pathname);

export const supabase = backendEnabled
  ? createClient(url!, key!, { auth: { flowType: 'implicit', detectSessionInUrl: true, persistSession: true, autoRefreshToken: true } })
  : null;
