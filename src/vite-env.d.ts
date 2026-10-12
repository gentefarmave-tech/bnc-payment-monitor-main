/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** URL publica del monitor-api (Railway). Es la unica variable del panel. */
  readonly VITE_MONITOR_API_URL: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
