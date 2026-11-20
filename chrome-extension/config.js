/** Public client config only — no service-role / AWS / OpenAI secrets. */

export const EXTENSION_VERSION = '1.0.0';

/** Production API. Change for local backend testing. */
export const API_BASE = 'https://www.getquickscribe.com';

/** Same public Supabase project the website uses (anon / publishable key only). */
export const SUPABASE_URL = 'https://vojesnnvehecenjymrko.supabase.co';
export const SUPABASE_ANON_KEY = 'sb_publishable_BhoKDe-_iL04tOVYCbbX0w_3TjKWaGG';

export const STORAGE_KEYS = {
  session: 'qs_med_ext_session',
  apiBase: 'qs_med_ext_api_base',
};

/** Tabs we may import a first-time login session from. */
export const LOCAL_API_BASE = 'http://127.0.0.1:8000';

export const SITE_ORIGIN_PATTERNS = [
  'https://www.getquickscribe.com/*',
  'https://getquickscribe.com/*',
  'https://quickscribe.co.il/*',
  'https://www.quickscribe.co.il/*',
  'http://127.0.0.1:8000/*',
  'http://localhost:8000/*',
  'http://127.0.0.1:5000/*',
  'http://localhost:5000/*',
];
