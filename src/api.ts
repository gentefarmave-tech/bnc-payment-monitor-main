// Cliente del monitor-api. El panel ya NO llama a ningun microservicio ni al Config Server:
// todo pasa por monitor-api, que guarda las credenciales y habla por la red privada.
// Unica variable de entorno del panel: VITE_MONITOR_API_URL (no es un secreto).

const BASE = ((import.meta.env.VITE_MONITOR_API_URL as string | undefined) ?? "").replace(/\/+$/, "");
export const API_CONFIGURED = BASE !== "";

export interface Session {
  token: string;
  username: string;
  role: string;
  expiresAt: string;
}

export interface Features {
  p2p: boolean;     // ENABLE_TEST_ACTIONS del monitor-api
  webhook: boolean; // ENABLE_WEBHOOK_TRIGGER del monitor-api
}

const KEY = "monitor.session";
let current: Session | null = null;
let onUnauthorized: (() => void) | null = null;

export function setUnauthorizedHandler(fn: (() => void) | null) {
  onUnauthorized = fn;
}

export function getSession(): Session | null {
  if (current) return current;
  try {
    const raw = sessionStorage.getItem(KEY);
    if (raw) {
      const s = JSON.parse(raw) as Session;
      if (s?.token && new Date(s.expiresAt).getTime() > Date.now()) current = s;
    }
  } catch { /* sin almacenamiento: la sesion vive solo en memoria */ }
  return current;
}

export function saveSession(s: Session) {
  current = s;
  try { sessionStorage.setItem(KEY, JSON.stringify(s)); } catch { /* ignorar */ }
}

export function clearSession() {
  current = null;
  try { sessionStorage.removeItem(KEY); } catch { /* ignorar */ }
}

export async function login(username: string, password: string): Promise<Session> {
  if (!API_CONFIGURED) throw new Error("Falta configurar VITE_MONITOR_API_URL en el panel.");
  let res: Response;
  try {
    res = await fetch(`${BASE}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    throw new Error("No se pudo conectar con el servicio del monitor.");
  }
  if (res.status === 401) throw new Error("Credenciales incorrectas");
  if (res.status === 429) throw new Error("Demasiados intentos. Espera unos minutos.");
  if (!res.ok) throw new Error(`Error del servicio (HTTP ${res.status})`);
  const d = await res.json();
  const s: Session = { token: d.accessToken, username: d.user?.username ?? username, role: d.user?.role ?? "", expiresAt: d.expiresAt };
  saveSession(s);
  return s;
}

/** Llamada autenticada. Si el token vencio (401) cierra la sesion del panel. */
export async function api(path: string, init: { method?: string; body?: unknown; timeoutMs?: number } = {}): Promise<Response> {
  const s = getSession();
  const headers: Record<string, string> = { Accept: "application/json" };
  if (s) headers.Authorization = `Bearer ${s.token}`;
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`${BASE}${path}`, {
    method: init.method ?? "GET",
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(init.timeoutMs ?? 12000),
  });
  if (res.status === 401 && onUnauthorized) onUnauthorized();
  return res;
}

export async function fetchFeatures(): Promise<Features> {
  try {
    const res = await api("/api/me");
    if (!res.ok) return { p2p: false, webhook: false };
    const d = await res.json();
    return { p2p: !!d?.testActions?.p2p, webhook: !!d?.testActions?.webhook };
  } catch {
    return { p2p: false, webhook: false };
  }
}
