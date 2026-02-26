import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm'

const supabaseUrl = 'https://vojesnnvehecenjymrko.supabase.co'
const supabaseAnonKey = 'sb_publishable_BhoKDe-_iL04tOVYCbbX0w_3TjKWaGG'

export const supabase = createClient(supabaseUrl, supabaseAnonKey)