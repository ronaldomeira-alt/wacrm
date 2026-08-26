import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || ''
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || ''

// A função supabaseAdmin() é a forma correta de obter o client admin singleton
// para evitar criar múltiplas instâncias.
let _client: ReturnType<typeof createClient> | null = null

export const supabaseAdmin = () => {
  if (_client) {
    return _client
  }

  if (!supabaseUrl || !supabaseServiceKey) {
    throw new Error('Missing Supabase URL or Service Role Key for admin client')
  }

  _client = createClient(supabaseUrl, supabaseServiceKey, {
    auth: {
      persistSession: false,
    },
  })

  return _client
}
