// Use bundled ESM build to avoid runtime "/npm/..." sub-imports on app origin.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2?bundle'

const supabaseUrl = 'https://vojesnnvehecenjymrko.supabase.co'
const supabaseAnonKey = 'sb_publishable_BhoKDe-_iL04tOVYCbbX0w_3TjKWaGG'

export const supabase = createClient(supabaseUrl, supabaseAnonKey)