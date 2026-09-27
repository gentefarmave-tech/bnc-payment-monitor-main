/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_EUREKA_URL: string;
  readonly VITE_CONFIG_SERVER_URL: string;
  readonly VITE_WEBHOOKS_URL: string;
  readonly VITE_P2P_URL: string;
  readonly VITE_EVENT_DISPATCHER_URL: string;
  readonly VITE_NOTIFICATION_URL: string;
  readonly VITE_BNC_API_KEY: string;
  readonly VITE_BNC_AUTH_TOKEN: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
