/// <reference types="vite/client" />

// Build-time environment variables injected by Vite (import.meta.env).
// Set these in a local `.env` file (see .env.example). They get baked into the
// built extension so distributed users don't have to enter Supabase settings.
interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_ANON_KEY?: string;
  readonly VITE_SUPABASE_TABLE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
