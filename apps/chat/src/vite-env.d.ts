/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_TURN_URLS?: string;
  readonly VITE_TURN_USERNAME?: string;
  readonly VITE_TURN_CREDENTIAL?: string;
  readonly VITE_TURN_USE_DEFAULT?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
