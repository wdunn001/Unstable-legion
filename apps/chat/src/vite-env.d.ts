/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

interface ImportMetaEnv {
  readonly VITE_TURN_URLS?: string;
  readonly VITE_TURN_USERNAME?: string;
  readonly VITE_TURN_CREDENTIAL?: string;
  readonly VITE_TURN_USE_DEFAULT?: string;
  // OpenPanel analytics (self-hosted). CLIENT_ID is required to
  // enable tracking — created in the OpenPanel dashboard; absent → no-op.
  readonly VITE_OPENPANEL_CLIENT_ID?: string;
  readonly VITE_OPENPANEL_API_URL?: string;
  readonly VITE_OPENPANEL_SCRIPT_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
