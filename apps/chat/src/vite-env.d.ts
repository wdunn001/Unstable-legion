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

// ── File System Access API — not yet in TypeScript's lib.dom.d.ts (Chrome/
// Edge only; see `useModelFolder.ts`'s `supported` feature-detect). Just
// enough surface for the "load model layers from a local folder" feature:
// picking a folder and re-verifying/re-requesting read permission on a
// handle restored from IndexedDB across visits. ───────────────────────────
interface FileSystemHandlePermissionDescriptor {
  mode?: 'read' | 'readwrite';
}

interface FileSystemHandle {
  queryPermission?(descriptor?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>;
  requestPermission?(descriptor?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>;
}

interface DirectoryPickerOptions {
  id?: string;
  mode?: 'read' | 'readwrite';
  startIn?: FileSystemHandle | string;
}

interface Window {
  showDirectoryPicker?(options?: DirectoryPickerOptions): Promise<FileSystemDirectoryHandle>;
}
