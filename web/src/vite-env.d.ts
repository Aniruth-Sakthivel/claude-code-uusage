/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL: string;
  readonly VITE_SUPABASE_ANON_KEY: string;
  /** Optional — dashboard WS features no-op entirely when unset. */
  readonly VITE_PUBLIC_WS_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
