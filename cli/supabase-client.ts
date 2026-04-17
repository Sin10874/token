import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = 'https://ykfvukzdmlyfiopjkziv.supabase.co'
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlrZnZ1a3pkbWx5ZmlvcGpreml2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU1MjQ2MzMsImV4cCI6MjA5MTEwMDYzM30.EsOKjoqMNziEWOsWLc6qUIO7PjwOMWEZmQ7bpbf-Nbw'

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
