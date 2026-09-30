// ============================================================
// BNC Payment Monitor Dashboard — v2.0 DYNAMIC
// Endpoints mapeados desde: API Payment Gente Appp.postman_collection.json
// ============================================================

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import {
  AreaChart, Area, BarChart, Bar, XAxis, YAxis,
  CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from "recharts";
import {
  Activity, AlertTriangle, Bell, CheckCircle2,
  ChevronRight, CreditCard, Database,
  Home, LogOut, Menu, Moon, RefreshCw,
  Settings, Sun, XCircle, Zap, ExternalLink, Copy,
  ArrowLeftRight, Clock, Filter, Layers, Send,
  RotateCcw, Wifi, WifiOff, Eye, EyeOff, Terminal,
  Play, Shield, Webhook,
} from "lucide-react";

// ─────────────────────────────────────────────────────────────
// ENDPOINTS REALES — mapeados de la colección Postman
// ─────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────
// BASE URLs — configurables via variables de entorno (Vite: VITE_*).
// En Railway, cada una de estas se define como Variable del servicio
// y Vite las incluye en el build (npm run build). Los valores de abajo
// son el fallback de Production, por si alguna variable no esta seteada.
// Ver .env.example para la lista completa.
// ─────────────────────────────────────────────────────────────
const EUREKA_URL           = import.meta.env.VITE_EUREKA_URL           || "https://eureka-server-main-production.up.railway.app";
const CONFIG_SERVER_URL    = import.meta.env.VITE_CONFIG_SERVER_URL    || "https://config-server-main-production.up.railway.app";
const WEBHOOKS_URL         = import.meta.env.VITE_WEBHOOKS_URL         || "https://esolutions-api-main-production.up.railway.app";
const P2P_URL              = import.meta.env.VITE_P2P_URL              || "https://msvc-p2p-production.up.railway.app";
const EVENT_DISPATCHER_URL = import.meta.env.VITE_EVENT_DISPATCHER_URL || "https://msvc-event-dispatcher-production.up.railway.app";
const NOTIFICATION_URL     = import.meta.env.VITE_NOTIFICATION_URL     || "https://msvc-notification-main-production.up.railway.app";

const ENDPOINTS = {
  // ── Health / Actuator ────────────────────────────────────
  health: {
    eureka:         `${EUREKA_URL}/actuator/health`,
    eurekaMetrics:  `${EUREKA_URL}/actuator/metrics`,
    configServer:   `${CONFIG_SERVER_URL}/actuator/health`,
    configRefresh:  `${CONFIG_SERVER_URL}/actuator/refresh`,
    webhooks:       `${WEBHOOKS_URL}/actuator/health`,
    p2p:            `${P2P_URL}/actuator/health`,
    p2pRefresh:     `${P2P_URL}/actuator/refresh`,
    reconciliation: `${EVENT_DISPATCHER_URL}/api/v1/health/reconciliation`,
  },
  // ── Config Server ────────────────────────────────────────
  config: {
    webhooksDefault: `${CONFIG_SERVER_URL}/msvc-webhooks/default`,
    webhooksStaging: `${CONFIG_SERVER_URL}/msvc-webhooks/staging`,
    webhooksProd:    `${CONFIG_SERVER_URL}/msvc-webhooks/prod`,
  },
  // ── Transactions (P2P Service) ────────────────────────────
  transactions: {
    baseUrl:  P2P_URL,
    list:     `${P2P_URL}/api/transactions`,
    summary:  `${P2P_URL}/api/transactions/summary`,
    hourly:   `${P2P_URL}/api/transactions/hourly`,
    detail:   (id: string) => `${P2P_URL}/api/transactions/${id}`,
  },
  // ── P2P Payment ───────────────────────────────────────────
  p2pPayment: `${P2P_URL}/api/v1/payments/p2p`,
  // ── Webhooks ──────────────────────────────────────────────
  webhookNotification: `${WEBHOOKS_URL}/api/v1/webhooks/notification`,
  webhookAudit: `${WEBHOOKS_URL}/api/v1/audit`,
  // ── Notifications ─────────────────────────────────────────
  notificationSend: `${NOTIFICATION_URL}/api/v1/notifications/send`,
};

// Credenciales — YA NO se hardcodean. Vienen de variables de entorno
// (locales via .env, en Railway via Variables del servicio). Si faltan,
// la app sigue arrancando pero avisa en consola y los requests que las
// necesiten van a fallar con 401/403 hasta que se configuren.
const API_KEY    = import.meta.env.VITE_BNC_API_KEY    || "";
const AUTH_TOKEN = import.meta.env.VITE_BNC_AUTH_TOKEN || "";
if (!API_KEY || !AUTH_TOKEN) {
  console.warn(
    "[BNC Monitor] Faltan VITE_BNC_API_KEY / VITE_BNC_AUTH_TOKEN. " +
    "Configura tu .env local (ver .env.example) o las Variables del servicio en Railway."
  );
}
// TENANT_ID ("50") pendiente: no hay accion de UI que llame a notificationSend todavia,
// por eso no se usa aun. Cuando se implemente el test de Notification, agregar
// header "X-Tenant-ID" con el tenant correspondiente a ese fetch.

// ─────────────────────────────────────────────────────────────
// TIPOS
// ─────────────────────────────────────────────────────────────
type ServiceStatus = "UP" | "DOWN" | "LOADING" | "UNKNOWN";

interface ServiceHealth {
  name: string;
  key: keyof typeof ENDPOINTS.health;
  status: ServiceStatus;
  latencyMs: number | null;
  lastChecked: Date | null;
  detail: string;
  method?: "GET" | "POST";
}

interface Transaction {
  id: number;
  operationRef: string;
  type: string;
  status: string;
  amount: number;
  authorizationCode?: string;
  referenceNumber?: string;
  beneficiaryId?: string;
  name?: string;
  cellPhone?: string;
  bankCode?: number;
  description?: string;
  createdAt: string;
  // Reconciliación activa P2P (ver hallazgo-timeout-p2p-transaccion-huerfana.md)
  reconciliationAttempts?: number;
  lastReconciliationAt?: string | null;
}

// ── Correlación P2P ↔ Webhook ────────────────────────────────
// Cruza cada transacción P2P (GET /api/transactions, msvc-p2p) con su
// notificación de BNC correspondiente (GET /api/v1/audit, ESolutions-API-main
// / msvc-webhooks), usando operationRef === transactionId como llave.
// Ver hallazgo-timeout-p2p-transaccion-huerfana.md: la "ventana de espera"
// usa el mismo umbral que el job de reconciliación activa (20 min,
// p2p.reconciliation.stuck-after-minutes en Config Server).
type WebhookCorrStatus = "RECEIVED" | "PENDING" | "MISSING" | "NA";

interface WebhookCorrelationRow {
  operationRef: string;
  beneficiaryName: string;
  beneficiaryId: string;
  amount: number;
  bankCode: number;
  p2pStatus: "SUCCESS" | "FAILED";
  p2pAt: string;
  webhookStatus: WebhookCorrStatus;
  webhookAt: string | null;
  latencyMs: number | null;
}

interface WebhookAudit {
  eventId: string;
  eventType: string | null;
  transactionId: string | null;
  status: string;
  detail: string | null;
  timestamp: string;
  ipOrigin: string | null;
  projectSource: string | null;
  paymentCategory: string | null;
}

const WEBHOOK_WAIT_WINDOW_MINUTES = 20;

function buildWebhookCorrelation(txList: Transaction[], audits: WebhookAudit[]): WebhookCorrelationRow[] {
  const now = Date.now();
  return txList
    .filter(tx => tx.type === "P2P")
    .map(tx => {
      // Auditorías que llegaron para esta transacción, más recientes primero.
      //
      // OJO: msvc-webhooks guarda en WebhookAudit.transactionId la referencia
      // que da el BNC (request.originBankReference(), ej. "59464"), NO nuestro
      // operationRef interno (ej. "aa2e1900df7f4a98ba1a"). Son campos distintos
      // en msvc-p2p: TransactionDetailDto.referenceNumber es la que coincide
      // con el transactionId de la auditoria; operationRef es solo nuestra
      // referencia interna y nunca aparece en el lado del webhook. Cruzar por
      // operationRef (como hacia antes esta funcion) nunca encontraba match, y
      // por eso la pestaña se quedaba en "Pendiente" para siempre aunque el
      // webhook ya hubiera llegado.
      const matches = audits
        .filter(a => !!tx.referenceNumber && a.transactionId === tx.referenceNumber)
        .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

      const success = matches.find(a => a.status === "WEBHOOK_SUCCESS" || a.status === "WEBHOOK_RECEIVED");
      const processing = matches.find(a => a.status === "WEBHOOK_PROCESSING");
      const errored = matches.find(a => a.status === "WEBHOOK_ERROR" || a.status === "WEBHOOK_DUPLICATE");

      let webhookStatus: WebhookCorrStatus;
      let webhookAt: string | null = null;
      let latencyMs: number | null = null;

      if (tx.status !== "SUCCESS") {
        webhookStatus = "NA";
      } else if (success) {
        webhookStatus = "RECEIVED";
        webhookAt = success.timestamp;
        latencyMs = new Date(success.timestamp).getTime() - new Date(tx.createdAt).getTime();
      } else if (processing) {
        webhookStatus = "PENDING";
      } else if (errored) {
        webhookStatus = "MISSING";
      } else {
        const minutesSinceP2P = (now - new Date(tx.createdAt).getTime()) / 60000;
        webhookStatus = minutesSinceP2P < WEBHOOK_WAIT_WINDOW_MINUTES ? "PENDING" : "MISSING";
      }

      const row: WebhookCorrelationRow = {
        operationRef: tx.operationRef,
        beneficiaryName: tx.name ?? "—",
        beneficiaryId: tx.beneficiaryId ?? "—",
        amount: tx.amount,
        bankCode: tx.bankCode ?? 0,
        p2pStatus: tx.status === "SUCCESS" ? "SUCCESS" : "FAILED",
        p2pAt: tx.createdAt,
        webhookStatus,
        webhookAt,
        latencyMs,
      };
      return row;
    });
}

function webhookCorrBadge(status: WebhookCorrStatus): { label: string; className: string } {
  switch (status) {
    case "RECEIVED": return { label: "Recibido",    className: "bg-green-500/15 text-green-400" };
    case "PENDING":  return { label: "Pendiente",   className: "bg-yellow-500/15 text-yellow-400" };
    case "MISSING":  return { label: "No recibido", className: "bg-red-500/15 text-red-400" };
    default:         return { label: "N/A",         className: "bg-gray-500/15 text-gray-400" };
  }
}

interface TxSummary {
  totalToday: number;
  successCount: number;
  failedCount: number;
  totalAmountProcesed: number;
}

interface HourlyStat {
  hour: string;
  ok: number;
  error: number;
}

interface LogEntry {
  ts: string;
  level: "INFO" | "OK" | "WARN" | "ERROR";
  message: string;
}

interface ReconciliationInfo {
  status: string;
  dlqMessagesPending: number | null;
  connectionStatus: string | null;
  unresolvedIncidents: number | null;
  latencyMs: number;
  lastChecked: Date | null;
  error: string | null;
}

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────
const now = () => new Date().toLocaleTimeString("es-VE");

const statusColor = (s: ServiceStatus) => {
  if (s === "UP")      return "text-green-400";
  if (s === "DOWN")    return "text-red-400";
  if (s === "LOADING") return "text-yellow-400";
  return "text-gray-500";
};

const statusBg = (s: ServiceStatus) => {
  if (s === "UP")      return "bg-green-400/10 border-green-500/30";
  if (s === "DOWN")    return "bg-red-400/10 border-red-500/30";
  if (s === "LOADING") return "bg-yellow-400/10 border-yellow-500/30";
  return "bg-gray-700/30 border-gray-600/30";
};

const txStatusColor = (s: string) => {
  if (s === "SUCCESS")    return "text-green-400 bg-green-400/10";
  if (s === "FAILED")     return "text-red-400 bg-red-400/10";
  if (s === "PROCESSING") return "text-yellow-400 bg-yellow-400/10";
  return "text-gray-400 bg-gray-700";
};

async function fetchHealth(url: string, method: "GET" | "POST" = "GET"): Promise<{ status: ServiceStatus; detail: string; latencyMs: number }> {
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    const latencyMs = Date.now() - t0;
    if (!res.ok) {
      return { status: "DOWN", detail: `HTTP ${res.status}`, latencyMs };
    }
    let detail = "UP";
    let overallStatus: ServiceStatus = "UP";
    try {
      const data = await res.json();
      detail = data?.status ?? (data?.healthy ? "UP" : "OK");
      // Algunos endpoints (ej. reconciliation) devuelven HTTP 200 aunque el
      // estado real sea malo (status: "RED"/"DOWN"/"FAILED"). Reflejarlo.
      if (typeof data?.status === "string" && ["RED", "DOWN", "FAILED", "ERROR"].includes(data.status.toUpperCase())) {
        overallStatus = "DOWN";
      }
    } catch { /* ignore */ }
    return { status: overallStatus, detail, latencyMs };
  } catch (err: unknown) {
    const latencyMs = Date.now() - t0;
    const msg = err instanceof Error ? err.message : "Network error";
    return { status: "DOWN", detail: msg.slice(0, 60), latencyMs };
  }
}

// ─────────────────────────────────────────────────────────────
// RECONCILIATION — poll dedicado con mas detalle (DLQ / incidentes)
// ─────────────────────────────────────────────────────────────
async function fetchReconciliation(url: string): Promise<ReconciliationInfo> {
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    const latencyMs = Date.now() - t0;
    if (!res.ok) {
      return { status: "UNKNOWN", dlqMessagesPending: null, connectionStatus: null, unresolvedIncidents: null, latencyMs, lastChecked: new Date(), error: `HTTP ${res.status}` };
    }
    const data = await res.json();
    return {
      status: typeof data?.status === "string" ? data.status : "UNKNOWN",
      dlqMessagesPending: typeof data?.dlqMessagesPending === "number" ? data.dlqMessagesPending : null,
      connectionStatus: typeof data?.connectionStatus === "string" ? data.connectionStatus : null,
      unresolvedIncidents: typeof data?.unresolvedIncidents === "number" ? data.unresolvedIncidents : null,
      latencyMs,
      lastChecked: new Date(),
      error: null,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Network error";
    return { status: "UNKNOWN", dlqMessagesPending: null, connectionStatus: null, unresolvedIncidents: null, latencyMs: Date.now() - t0, lastChecked: new Date(), error: msg.slice(0, 80) };
  }
}

// ─────────────────────────────────────────────────────────────
// INITIAL SERVICE LIST
// ─────────────────────────────────────────────────────────────
const INITIAL_SERVICES: ServiceHealth[] = [
  { name: "Eureka Server",         key: "eureka",         status: "UNKNOWN", latencyMs: null, lastChecked: null, detail: "—" },
  { name: "Eureka Metrics",        key: "eurekaMetrics",  status: "UNKNOWN", latencyMs: null, lastChecked: null, detail: "—" },
  { name: "Config Server",         key: "configServer",   status: "UNKNOWN", latencyMs: null, lastChecked: null, detail: "—" },
  { name: "Config Refresh",        key: "configRefresh",  status: "UNKNOWN", latencyMs: null, lastChecked: null, detail: "—" },
  { name: "Webhooks Service",      key: "webhooks",       status: "UNKNOWN", latencyMs: null, lastChecked: null, detail: "—" },
  { name: "P2P Service",           key: "p2p",            status: "UNKNOWN", latencyMs: null, lastChecked: null, detail: "—" },
  { name: "P2P Refresh",           key: "p2pRefresh",     status: "UNKNOWN", latencyMs: null, lastChecked: null, detail: "—", method: "POST" },
  { name: "Worker Reconciliation", key: "reconciliation", status: "UNKNOWN", latencyMs: null, lastChecked: null, detail: "—" },
];

// ─────────────────────────────────────────────────────────────
// FALLBACK HOURLY DATA (si el endpoint no responde aún)
// ─────────────────────────────────────────────────────────────
const FALLBACK_HOURLY: HourlyStat[] = Array.from({ length: 24 }, (_, i) => ({
  hour: `${String(i).padStart(2, "0")}:00`,
  ok: 0,
  error: 0,
}));

// ─────────────────────────────────────────────────────────────
// APP ROOT
// ─────────────────────────────────────────────────────────────
export default function App() {
  const [darkMode, setDarkMode]     = useState(true);
  const [sidebarOpen, setSidebar]   = useState(true);
  const [activeTab, setActiveTab]   = useState<"overview" | "health" | "transactions" | "webhookcorr" | "p2p" | "webhooks" | "config" | "logs">("overview");
  const [authed, setAuthed]         = useState(false);
  const [loginUser, setLoginUser]   = useState("");
  const [loginPass, setLoginPass]   = useState("");
  const [showPass, setShowPass]     = useState(false);
  const [loginErr, setLoginErr]     = useState("");

  // Health
  const [services, setServices]     = useState<ServiceHealth[]>(INITIAL_SERVICES);
  const [checking, setChecking]     = useState(false);
  const [reconInfo, setReconInfo]   = useState<ReconciliationInfo | null>(null);

  // Transactions
  const [txSummary, setTxSummary]   = useState<TxSummary | null>(null);
  const [txList, setTxList]         = useState<Transaction[]>([]);
  const [hourly, setHourly]         = useState<HourlyStat[]>(FALLBACK_HOURLY);
  const [txFilter, setTxFilter]     = useState({ type: "", status: "", from: "", to: "", amount: "", beneficiary: "", operationRef: "", page: 0 });
  const [txLoading, setTxLoading]   = useState(false);
  const [txDetail, setTxDetail]     = useState<Transaction | null>(null);
  const [txSearch, setTxSearch]     = useState("");

  // Correlación P2P ↔ Webhook
  const [webhookAudits, setWebhookAudits]     = useState<WebhookAudit[]>([]);
  const [webhookCorrLoading, setWebhookCorrLoading] = useState(false);
  const [webhookCorrError, setWebhookCorrError]     = useState<string | null>(null);

  // P2P form
  const [p2pForm, setP2pForm]       = useState({
    Amount: "10.01", BeneficiaryBankCode: "191",
    BeneficiaryCellPhone: "584242207524", BeneficiaryEmail: "vonealmar@gmail.com",
    BeneficiaryID: "V23000760", BeneficiaryName: "test name",
    Description: "description", OperationRef: "", ChildClientID: "", BranchID: "",
  });
  const [p2pResult, setP2pResult]   = useState<string>("");
  const [p2pLoading, setP2pLoading] = useState(false);

  // Webhook form
  const [whForm, setWhForm]         = useState({
    PaymentType: "P2P", OriginBankReference: "998877665570",
    DestinyBankReference: "112233445566", OriginBankCode: "0191",
    Hour: "1430", CurrencyCode: "0928", Amount: "12500.50",
    Date: "20240327", CommerceID: "J123456789",
    CommercePhone: "00584149876543", ClientPhone: "00584121234567",
    Concept: "Pago de comida y bebidas menu especial",
  });
  const [whResult, setWhResult]     = useState("");
  const [whLoading, setWhLoading]   = useState(false);

  // Config
  const [configEnv, setConfigEnv]   = useState<"default" | "staging" | "prod">("staging");
  const [configData, setConfigData] = useState<string>("");
  const [configLoading, setConfigLoading] = useState(false);
  const [refreshResult, setRefreshResult] = useState("");
  const [refreshLoading, setRefreshLoading] = useState(false);

  // Logs
  const [logs, setLogs]             = useState<LogEntry[]>([]);
  const logsEndRef                  = useRef<HTMLDivElement>(null);

  const addLog = useCallback((level: LogEntry["level"], message: string) => {
    setLogs(prev => [...prev.slice(-199), { ts: now(), level, message }]);
  }, []);

  // ── Auth ────────────────────────────────────────────────
  const handleLogin = (e: React.FormEvent) => {
    e.preventDefault();
    if (loginUser === "admin" && loginPass === "bnc2026") {
      setAuthed(true);
      addLog("OK", "Sesión iniciada como admin");
    } else {
      setLoginErr("Credenciales incorrectas");
    }
  };

  // ── Check individual service ─────────────────────────────
  const checkService = useCallback(async (idx: number) => {
    setServices(prev => prev.map((s, i) => i === idx ? { ...s, status: "LOADING" } : s));
    const svc = INITIAL_SERVICES[idx];
    const url = ENDPOINTS.health[svc.key];
    const method = svc.method ?? "GET";
    addLog("INFO", `Checking ${svc.name}…`);
    const result = await fetchHealth(url, method);
    setServices(prev => prev.map((s, i) =>
      i === idx ? { ...s, ...result, lastChecked: new Date() } : s
    ));
    addLog(result.status === "UP" ? "OK" : "ERROR", `${svc.name}: ${result.status} (${result.latencyMs}ms)`);
  }, [addLog]);

  // ── Check all services ───────────────────────────────────
  const checkAll = useCallback(async () => {
    setChecking(true);
    addLog("INFO", "Verificando todos los servicios…");
    setServices(prev => prev.map(s => ({ ...s, status: "LOADING" as ServiceStatus })));
    await Promise.all(
      INITIAL_SERVICES.map(async (svc, idx) => {
        const url = ENDPOINTS.health[svc.key];
        const method = svc.method ?? "GET";
        const result = await fetchHealth(url, method);
        setServices(prev => prev.map((s, i) =>
          i === idx ? { ...s, ...result, lastChecked: new Date() } : s
        ));
        addLog(result.status === "UP" ? "OK" : "ERROR",
          `${svc.name}: ${result.status} (${result.latencyMs}ms — ${result.detail})`);
      })
    );
    setChecking(false);
    addLog("INFO", "Health check completado.");
  }, [addLog]);

  // ── Fetch transactions ────────────────────────────────────
  const fetchTransactions = useCallback(async () => {
    setTxLoading(true);
    addLog("INFO", "Cargando transacciones…");
    try {
      const params = new URLSearchParams();
      if (txFilter.type)         params.set("type",         txFilter.type);
      if (txFilter.status)       params.set("status",       txFilter.status);
      if (txFilter.from)         params.set("from",         txFilter.from);
      if (txFilter.to)           params.set("to",           txFilter.to);
      if (txFilter.amount)       params.set("amount",       txFilter.amount);
      if (txFilter.beneficiary)  params.set("beneficiary",  txFilter.beneficiary);
      if (txFilter.operationRef) params.set("operationRef", txFilter.operationRef);
      params.set("page", String(txFilter.page));
      params.set("size", "20");

      const [listRes, summaryRes, hourlyRes] = await Promise.all([
        fetch(`${ENDPOINTS.transactions.list}?${params}`, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(10000) }),
        fetch(ENDPOINTS.transactions.summary, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(10000) }),
        fetch(ENDPOINTS.transactions.hourly,  { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(10000) }),
      ]);

      if (listRes.ok) {
        const data = await listRes.json();
        setTxList(data.content ?? data ?? []);
        addLog("OK", `${(data.content ?? data ?? []).length} transacciones cargadas`);
      } else {
        addLog("WARN", `Transactions list: HTTP ${listRes.status}`);
      }

      if (summaryRes.ok) {
        const s = await summaryRes.json();
        setTxSummary(s);
        addLog("OK", `KPIs: ${s.totalToday} hoy, ${s.successCount} OK, ${s.failedCount} fail`);
      }

      if (hourlyRes.ok) {
        const h = await hourlyRes.json();
        setHourly(h);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Error";
      addLog("ERROR", `fetchTransactions: ${msg}`);
    }
    setTxLoading(false);
  }, [txFilter, addLog]);

  // ── Fetch webhook audit log (para la correlación P2P ↔ Webhook) ──
  const fetchWebhookAudits = useCallback(async () => {
    setWebhookCorrLoading(true);
    setWebhookCorrError(null);
    addLog("INFO", "Cargando historial de webhooks (audit log)…");
    try {
      const params = new URLSearchParams({ page: "0", size: "100", sort: "timestamp,desc" });
      const res = await fetch(`${ENDPOINTS.webhookAudit}?${params}`, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(10000),
      });
      if (res.ok) {
        const data = await res.json();
        const content: WebhookAudit[] = data.content ?? data ?? [];
        setWebhookAudits(content);
        addLog("OK", `${content.length} registros de auditoría cargados`);
      } else {
        setWebhookCorrError(`Audit log: HTTP ${res.status}`);
        addLog("WARN", `Audit log: HTTP ${res.status}`);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Error";
      setWebhookCorrError(msg);
      addLog("ERROR", `fetchWebhookAudits: ${msg}`);
    }
    setWebhookCorrLoading(false);
  }, [addLog]);

  // ── Send P2P ──────────────────────────────────────────────
  const sendP2P = async () => {
    setP2pLoading(true);
    setP2pResult("");
    addLog("INFO", `Enviando P2P → ${p2pForm.BeneficiaryName} (${p2pForm.Amount})`);
    try {
      const res = await fetch(ENDPOINTS.p2pPayment, {
        method: "POST",
        headers: {
          "Content-Type":  "application/json",
          "x-api-key":     API_KEY,
          "Authorization": AUTH_TOKEN,
        },
        body: JSON.stringify({ ...p2pForm, Amount: parseFloat(p2pForm.Amount), BeneficiaryBankCode: parseInt(p2pForm.BeneficiaryBankCode) }),
        signal: AbortSignal.timeout(15000),
      });
      const text = await res.text();
      setP2pResult(text);
      addLog(res.ok ? "OK" : "WARN", `P2P response: HTTP ${res.status}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Error";
      setP2pResult(`ERROR: ${msg}`);
      addLog("ERROR", msg);
    }
    setP2pLoading(false);
  };

  // ── Send Webhook ──────────────────────────────────────────
  const sendWebhook = async () => {
    setWhLoading(true);
    setWhResult("");
    addLog("INFO", `Disparando webhook → ${ENDPOINTS.webhookNotification}`);
    try {
      const res = await fetch(ENDPOINTS.webhookNotification, {
        method: "POST",
        headers: {
          "Content-Type":  "application/json",
          "x-api-key":     API_KEY,
          "Authorization": AUTH_TOKEN,
        },
        body: JSON.stringify(whForm),
        signal: AbortSignal.timeout(15000),
      });
      const text = await res.text();
      setWhResult(text);
      addLog(res.ok ? "OK" : "WARN", `Webhook response: HTTP ${res.status}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Error";
      setWhResult(`ERROR: ${msg}`);
      addLog("ERROR", msg);
    }
    setWhLoading(false);
  };

  // ── Load config ───────────────────────────────────────────
  const loadConfig = async () => {
    setConfigLoading(true);
    setConfigData("");
    const url = ENDPOINTS.config[`webhooks${configEnv.charAt(0).toUpperCase() + configEnv.slice(1)}` as keyof typeof ENDPOINTS.config];
    addLog("INFO", `Config Server → ${url}`);
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
      const text = await res.text();
      try {
        setConfigData(JSON.stringify(JSON.parse(text), null, 2));
      } catch {
        setConfigData(text);
      }
      addLog(res.ok ? "OK" : "WARN", `Config: HTTP ${res.status}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Error";
      setConfigData(`ERROR: ${msg}`);
      addLog("ERROR", msg);
    }
    setConfigLoading(false);
  };

  // ── P2P Actuator Refresh ──────────────────────────────────
  const triggerP2PRefresh = async () => {
    setRefreshLoading(true);
    setRefreshResult("");
    addLog("INFO", "Disparando actuator/refresh en P2P Service…");
    try {
      const res = await fetch(ENDPOINTS.health.p2pRefresh, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(15000),
      });
      const text = await res.text();
      setRefreshResult(text || `HTTP ${res.status} — OK`);
      addLog(res.ok ? "OK" : "WARN", `P2P Refresh: HTTP ${res.status}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Error";
      setRefreshResult(`ERROR: ${msg}`);
      addLog("ERROR", msg);
    }
    setRefreshLoading(false);
  };

  // ── Fetch tx detail ───────────────────────────────────────
  const fetchTxDetail = async (id: string) => {
    addLog("INFO", `Buscando transacción: ${id}`);
    try {
      const res = await fetch(ENDPOINTS.transactions.detail(id), {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(10000),
      });
      if (res.ok) {
        const d = await res.json();
        setTxDetail(d);
        addLog("OK", `Detalle cargado: ${d.operationRef}`);
      } else {
        addLog("WARN", `Transacción ${id}: HTTP ${res.status}`);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Error";
      addLog("ERROR", msg);
    }
  };

  // ── Auto scroll logs ──────────────────────────────────────
  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  // ── Poll reconciliation (DLQ / incidentes) cada 20s ──────
  // Corre aparte del "Check All" manual para que la alerta de
  // arriba se mantenga al dia sin que el usuario tenga que hacer nada.
  useEffect(() => {
    if (!authed) return;
    let cancelled = false;
    const poll = async () => {
      const info = await fetchReconciliation(ENDPOINTS.health.reconciliation);
      if (!cancelled) setReconInfo(info);
    };
    poll();
    const id = setInterval(poll, 20000);
    return () => { cancelled = true; clearInterval(id); };
  }, [authed]);

  // ── Load transactions when tab opens ─────────────────────
  useEffect(() => {
    if (authed && (activeTab === "transactions" || activeTab === "overview" || activeTab === "webhookcorr")) {
      fetchTransactions();
    }
    if (authed && activeTab === "webhookcorr") {
      fetchWebhookAudits();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authed, activeTab]);

  // ── Correlación P2P ↔ Webhook: derivada de txList + webhookAudits ──
  const webhookCorrRows = useMemo(
    () => buildWebhookCorrelation(txList, webhookAudits),
    [txList, webhookAudits]
  );

  // ─────────────────────────────────────────────────────────
  // LOGIN SCREEN
  // ─────────────────────────────────────────────────────────
  if (!authed) {
    return (
      <div className="min-h-screen bg-gray-950 flex items-center justify-center p-4">
        <div className="w-full max-w-sm">
          <div className="flex items-center gap-3 mb-8 justify-center">
            <div className="w-10 h-10 rounded-xl bg-green-500/20 flex items-center justify-center border border-green-500/40">
              <Shield size={20} className="text-green-400" />
            </div>
            <div>
              <h1 className="text-white font-bold text-lg leading-none">BNC Monitor</h1>
              <p className="text-gray-500 text-xs">Infraestructura · Staging</p>
            </div>
          </div>
          <form onSubmit={handleLogin} className="bg-gray-900 border border-gray-800 rounded-2xl p-6 space-y-4">
            <div>
              <label className="text-gray-400 text-xs mb-1 block">Usuario</label>
              <input
                value={loginUser} onChange={e => setLoginUser(e.target.value)}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-green-500"
                placeholder="admin" autoFocus
              />
            </div>
            <div>
              <label className="text-gray-400 text-xs mb-1 block">Contraseña</label>
              <div className="relative">
                <input
                  type={showPass ? "text" : "password"}
                  value={loginPass} onChange={e => setLoginPass(e.target.value)}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-green-500 pr-9"
                  placeholder="••••••••"
                />
                <button type="button" onClick={() => setShowPass(v => !v)}
                  className="absolute right-2 top-2 text-gray-500 hover:text-gray-300">
                  {showPass ? <EyeOff size={15}/> : <Eye size={15}/>}
                </button>
              </div>
            </div>
            {loginErr && <p className="text-red-400 text-xs">{loginErr}</p>}
            <button type="submit"
              className="w-full bg-green-600 hover:bg-green-500 text-white font-semibold py-2 rounded-lg text-sm transition-colors">
              Ingresar
            </button>
            <p className="text-center text-gray-600 text-xs">admin / bnc2026</p>
          </form>
        </div>
      </div>
    );
  }

  // ─────────────────────────────────────────────────────────
  // SIDEBAR ITEMS
  // ─────────────────────────────────────────────────────────
  const navItems = [
    { id: "overview",     icon: <Home size={16}/>,         label: "Overview" },
    { id: "health",       icon: <Activity size={16}/>,     label: "Health Check" },
    { id: "transactions", icon: <CreditCard size={16}/>,   label: "Transacciones" },
    { id: "webhookcorr",  icon: <Webhook size={16}/>,        label: "Correlación Webhook" },
    { id: "p2p",          icon: <ArrowLeftRight size={16}/>, label: "P2P / Webhooks" },
    { id: "config",       icon: <Settings size={16}/>,     label: "Config Server" },
    { id: "logs",         icon: <Terminal size={16}/>,     label: "Logs" },
  ] as const;

  const upCount   = services.filter(s => s.status === "UP").length;
  const downCount = services.filter(s => s.status === "DOWN").length;

  // ─────────────────────────────────────────────────────────
  // MAIN LAYOUT
  // ─────────────────────────────────────────────────────────
  return (
    <div className={darkMode ? "dark" : ""}>
      <div className="flex h-screen bg-gray-950 text-gray-100 font-mono overflow-hidden">

        {/* ── SIDEBAR ── */}
        <aside className={`${sidebarOpen ? "w-52" : "w-14"} transition-all duration-200 bg-gray-900 border-r border-gray-800 flex flex-col flex-shrink-0`}>
          {/* Logo */}
          <div className="h-14 flex items-center px-3 border-b border-gray-800 gap-2">
            <button onClick={() => setSidebar(v => !v)} className="text-gray-400 hover:text-white">
              <Menu size={18}/>
            </button>
            {sidebarOpen && (
              <span className="text-green-400 font-bold text-sm truncate">BNC Monitor</span>
            )}
          </div>

          {/* Nav */}
          <nav className="flex-1 p-2 space-y-1 overflow-y-auto">
            {navItems.map(item => (
              <button key={item.id}
                onClick={() => setActiveTab(item.id)}
                className={`w-full flex items-center gap-2 px-2 py-2 rounded-lg text-xs transition-colors
                  ${activeTab === item.id
                    ? "bg-green-500/15 text-green-400 border border-green-500/25"
                    : "text-gray-400 hover:text-white hover:bg-gray-800"}`}>
                {item.icon}
                {sidebarOpen && <span className="truncate">{item.label}</span>}
              </button>
            ))}
          </nav>

          {/* Bottom */}
          <div className="p-2 border-t border-gray-800 space-y-1">
            <button onClick={() => setDarkMode(v => !v)}
              className="w-full flex items-center gap-2 px-2 py-2 rounded-lg text-xs text-gray-400 hover:text-white hover:bg-gray-800">
              {darkMode ? <Sun size={16}/> : <Moon size={16}/>}
              {sidebarOpen && <span>{darkMode ? "Light" : "Dark"}</span>}
            </button>
            <button onClick={() => setAuthed(false)}
              className="w-full flex items-center gap-2 px-2 py-2 rounded-lg text-xs text-gray-400 hover:text-red-400 hover:bg-gray-800">
              <LogOut size={16}/>
              {sidebarOpen && <span>Salir</span>}
            </button>
          </div>
        </aside>

        {/* ── MAIN ── */}
        <main className="flex-1 flex flex-col overflow-hidden">
          {/* Topbar */}
          <header className="h-14 flex items-center px-4 border-b border-gray-800 bg-gray-900 gap-3 flex-shrink-0">
            <div className="flex items-center gap-2 flex-1">
              <span className="text-gray-500 text-xs">Production</span>
              <span className="text-gray-700">·</span>
              <span className="text-green-400 text-xs">{upCount} UP</span>
              {downCount > 0 && <span className="text-red-400 text-xs">{downCount} DOWN</span>}
            </div>
            <div className="flex items-center gap-2">
              <span className="text-gray-600 text-xs">{new Date().toLocaleString("es-VE")}</span>
              <button onClick={checkAll} disabled={checking}
                className="flex items-center gap-1 px-3 py-1.5 bg-green-600/20 hover:bg-green-600/30 border border-green-500/30 rounded-lg text-green-400 text-xs transition-colors disabled:opacity-50">
                <RefreshCw size={13} className={checking ? "animate-spin" : ""}/>
                Check All
              </button>
            </div>
          </header>

          {/* Content */}
          <div className="flex-1 overflow-y-auto p-4 space-y-4">

            {/* ══════════ OVERVIEW ══════════ */}
            {activeTab === "overview" && (
              <div className="space-y-4">
                <h2 className="text-white font-bold text-base flex items-center gap-2">
                  <Home size={16} className="text-green-400"/> Overview
                </h2>

                {/* Alerta de Reconciliacion — DLQ / incidentes sin resolver */}
                {reconInfo && (reconInfo.status?.toUpperCase() === "RED" || (reconInfo.unresolvedIncidents ?? 0) > 0 || (reconInfo.dlqMessagesPending ?? 0) > 0 || (reconInfo.connectionStatus && reconInfo.connectionStatus !== "OK") || reconInfo.error) && (
                  <div className="border border-red-500/40 bg-red-500/10 rounded-xl p-4 flex items-start gap-3">
                    <AlertTriangle size={20} className="text-red-400 flex-shrink-0 mt-0.5"/>
                    <div className="flex-1 min-w-0">
                      <div className="text-red-400 font-bold text-sm">Reconciliación en alerta</div>
                      <div className="text-gray-300 text-xs mt-1 flex flex-wrap gap-x-4 gap-y-1">
                        {reconInfo.error ? (
                          <span>No se pudo consultar: {reconInfo.error}</span>
                        ) : (
                          <>
                            <span>Incidentes sin resolver: <b className={reconInfo.unresolvedIncidents ? "text-red-400" : "text-gray-300"}>{reconInfo.unresolvedIncidents ?? "—"}</b></span>
                            <span>DLQ pendientes: <b className={reconInfo.dlqMessagesPending ? "text-red-400" : "text-gray-300"}>{reconInfo.dlqMessagesPending ?? "—"}</b></span>
                            <span>Conexión RabbitMQ: <b className={reconInfo.connectionStatus !== "OK" ? "text-red-400" : "text-green-400"}>{reconInfo.connectionStatus ?? "—"}</b></span>
                          </>
                        )}
                      </div>
                      {reconInfo.lastChecked && (
                        <div className="text-gray-500 text-[10px] mt-1">Última verificación: {reconInfo.lastChecked.toLocaleTimeString("es-VE")}</div>
                      )}
                    </div>
                  </div>
                )}

                {/* KPI Cards */}
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  {[
                    { label: "Total Hoy",     val: txSummary?.totalToday      ?? "—", icon: <Layers size={16}/>,       color: "text-blue-400" },
                    { label: "Exitosas",       val: txSummary?.successCount    ?? "—", icon: <CheckCircle2 size={16}/>, color: "text-green-400" },
                    { label: "Fallidas",       val: txSummary?.failedCount     ?? "—", icon: <XCircle size={16}/>,      color: "text-red-400" },
                    { label: "Monto Procesado",val: txSummary ? `Bs. ${txSummary.totalAmountProcesed.toLocaleString("es-VE")}` : "—", icon: <Zap size={16}/>, color: "text-yellow-400" },
                  ].map(k => (
                    <div key={k.label} className="bg-gray-900 border border-gray-800 rounded-xl p-4">
                      <div className={`${k.color} mb-2`}>{k.icon}</div>
                      <div className="text-white font-bold text-xl">{k.val}</div>
                      <div className="text-gray-500 text-xs mt-1">{k.label}</div>
                    </div>
                  ))}
                </div>

                {/* Services Summary */}
                <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                  {services.map((svc, i) => (
                    <div key={i} className={`border rounded-lg px-3 py-2 flex items-center gap-2 ${statusBg(svc.status)}`}>
                      {svc.status === "UP"    ? <Wifi size={12} className="text-green-400"/> :
                       svc.status === "DOWN"  ? <WifiOff size={12} className="text-red-400"/> :
                       svc.status === "LOADING" ? <RefreshCw size={12} className="text-yellow-400 animate-spin"/> :
                       <Activity size={12} className="text-gray-500"/>}
                      <div className="min-w-0">
                        <div className="text-xs text-gray-300 truncate">{svc.name}</div>
                        <div className={`text-xs font-bold ${statusColor(svc.status)}`}>
                          {svc.status}{svc.latencyMs !== null ? ` · ${svc.latencyMs}ms` : ""}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>

                {/* Hourly Chart */}
                {txLoading ? (
                  <div className="bg-gray-900 border border-gray-800 rounded-xl p-8 text-center text-gray-500 text-sm">
                    <RefreshCw size={20} className="animate-spin mx-auto mb-2"/>
                    Cargando datos…
                  </div>
                ) : (
                  <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
                    <div className="text-xs text-gray-400 mb-3 font-bold uppercase tracking-widest">Transacciones / hora (24h)</div>
                    <ResponsiveContainer width="100%" height={200}>
                      <AreaChart data={hourly}>
                        <defs>
                          <linearGradient id="gOk" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="5%"  stopColor="#22c55e" stopOpacity={0.3}/>
                            <stop offset="95%" stopColor="#22c55e" stopOpacity={0}/>
                          </linearGradient>
                          <linearGradient id="gErr" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="5%"  stopColor="#ef4444" stopOpacity={0.3}/>
                            <stop offset="95%" stopColor="#ef4444" stopOpacity={0}/>
                          </linearGradient>
                        </defs>
                        <CartesianGrid strokeDasharray="3 3" stroke="#1f2937"/>
                        <XAxis dataKey="hour" tick={{ fill: "#6b7280", fontSize: 10 }} interval={3}/>
                        <YAxis tick={{ fill: "#6b7280", fontSize: 10 }}/>
                        <Tooltip contentStyle={{ background: "#111827", border: "1px solid #374151", borderRadius: 8, fontSize: 11 }}/>
                        <Legend wrapperStyle={{ fontSize: 11 }}/>
                        <Area type="monotone" dataKey="ok"    stroke="#22c55e" fill="url(#gOk)"  name="OK"    strokeWidth={2}/>
                        <Area type="monotone" dataKey="error" stroke="#ef4444" fill="url(#gErr)" name="Error" strokeWidth={2}/>
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                )}
              </div>
            )}

            {/* ══════════ HEALTH CHECK ══════════ */}
            {activeTab === "health" && (
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <h2 className="text-white font-bold text-base flex items-center gap-2">
                    <Activity size={16} className="text-green-400"/> Health Check
                  </h2>
                  <button onClick={checkAll} disabled={checking}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-green-600 hover:bg-green-500 rounded-lg text-white text-xs font-semibold transition-colors disabled:opacity-50">
                    <RefreshCw size={13} className={checking ? "animate-spin" : ""}/>
                    Check All
                  </button>
                </div>

                <div className="grid gap-3">
                  {services.map((svc, idx) => (
                    <div key={idx} className={`border rounded-xl p-4 flex items-center gap-4 ${statusBg(svc.status)}`}>
                      {/* Status icon */}
                      <div className="flex-shrink-0">
                        {svc.status === "UP"      && <CheckCircle2 size={22} className="text-green-400"/>}
                        {svc.status === "DOWN"    && <XCircle      size={22} className="text-red-400"/>}
                        {svc.status === "LOADING" && <RefreshCw    size={22} className="text-yellow-400 animate-spin"/>}
                        {svc.status === "UNKNOWN" && <AlertTriangle size={22} className="text-gray-500"/>}
                      </div>

                      {/* Info */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-white font-semibold text-sm">{svc.name}</span>
                          {svc.method === "POST" && (
                            <span className="text-xs bg-yellow-500/20 text-yellow-400 border border-yellow-500/30 px-1.5 py-0.5 rounded">POST</span>
                          )}
                        </div>
                        <div className="text-gray-500 text-xs truncate">
                          {ENDPOINTS.health[svc.key]}
                        </div>
                        {svc.lastChecked && (
                          <div className="text-gray-600 text-xs flex items-center gap-1 mt-0.5">
                            <Clock size={10}/>
                            {svc.lastChecked.toLocaleTimeString("es-VE")}
                            {svc.detail !== "—" && <span>· {svc.detail}</span>}
                          </div>
                        )}
                      </div>

                      {/* Latency */}
                      {svc.latencyMs !== null && (
                        <div className="text-right flex-shrink-0">
                          <div className={`text-sm font-bold ${svc.latencyMs < 300 ? "text-green-400" : svc.latencyMs < 800 ? "text-yellow-400" : "text-red-400"}`}>
                            {svc.latencyMs}ms
                          </div>
                        </div>
                      )}

                      {/* Badge */}
                      <div className={`px-2.5 py-1 rounded-full text-xs font-bold flex-shrink-0 ${
                        svc.status === "UP"      ? "bg-green-500/20 text-green-400 border border-green-500/40" :
                        svc.status === "DOWN"    ? "bg-red-500/20 text-red-400 border border-red-500/40" :
                        svc.status === "LOADING" ? "bg-yellow-500/20 text-yellow-400 border border-yellow-500/40" :
                        "bg-gray-700/50 text-gray-500 border border-gray-600"
                      }`}>
                        {svc.status}
                      </div>

                      {/* Check button */}
                      <button onClick={() => checkService(idx)}
                        className="flex-shrink-0 p-2 rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-400 hover:text-white transition-colors">
                        <RefreshCw size={14}/>
                      </button>
                    </div>
                  ))}
                </div>

                {/* External link to Eureka */}
                <a href={EUREKA_URL} target="_blank" rel="noreferrer"
                  className="inline-flex items-center gap-1.5 text-xs text-blue-400 hover:text-blue-300 transition-colors">
                  <ExternalLink size={12}/> Abrir Eureka Dashboard
                </a>
              </div>
            )}

            {/* ══════════ TRANSACTIONS ══════════ */}
            {activeTab === "transactions" && (
              <div className="space-y-4">
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <h2 className="text-white font-bold text-base flex items-center gap-2">
                    <CreditCard size={16} className="text-green-400"/> Transacciones
                  </h2>
                  <button onClick={fetchTransactions} disabled={txLoading}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-green-600 hover:bg-green-500 rounded-lg text-white text-xs font-semibold transition-colors disabled:opacity-50">
                    <RefreshCw size={13} className={txLoading ? "animate-spin" : ""}/>
                    Actualizar
                  </button>
                </div>

                {/* Filters */}
                <div className="bg-gray-900 border border-gray-800 rounded-xl p-3 flex flex-wrap gap-2 items-end">
                  <div>
                    <label className="text-gray-500 text-xs block mb-1">Tipo</label>
                    <select value={txFilter.type} onChange={e => setTxFilter(f => ({...f, type: e.target.value, page: 0}))}
                      className="bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-white text-xs focus:outline-none focus:border-green-500">
                      <option value="">Todos</option>
                      <option value="P2P">P2P</option>
                      <option value="C2P">C2P</option>
                      <option value="TRF">TRF</option>
                    </select>
                  </div>
                  <div>
                    <label className="text-gray-500 text-xs block mb-1">Estado</label>
                    <select value={txFilter.status} onChange={e => setTxFilter(f => ({...f, status: e.target.value, page: 0}))}
                      className="bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-white text-xs focus:outline-none focus:border-green-500">
                      <option value="">Todos</option>
                      <option value="SUCCESS">SUCCESS</option>
                      <option value="FAILED">FAILED</option>
                      <option value="PROCESSING">PROCESSING</option>
                    </select>
                  </div>
                  <div>
                    <label className="text-gray-500 text-xs block mb-1">Desde</label>
                    <input type="datetime-local" value={txFilter.from}
                      onChange={e => setTxFilter(f => ({...f, from: e.target.value, page: 0}))}
                      className="bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-white text-xs focus:outline-none focus:border-green-500"/>
                  </div>
                  <div>
                    <label className="text-gray-500 text-xs block mb-1">Hasta</label>
                    <input type="datetime-local" value={txFilter.to}
                      onChange={e => setTxFilter(f => ({...f, to: e.target.value, page: 0}))}
                      className="bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-white text-xs focus:outline-none focus:border-green-500"/>
                  </div>
                  <div>
                    <label className="text-gray-500 text-xs block mb-1">Monto</label>
                    <input type="number" step="0.01" value={txFilter.amount}
                      onChange={e => setTxFilter(f => ({...f, amount: e.target.value, page: 0}))}
                      placeholder="150.00"
                      className="bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-white text-xs w-24 focus:outline-none focus:border-green-500"/>
                  </div>
                  <div>
                    <label className="text-gray-500 text-xs block mb-1">Beneficiario</label>
                    <input value={txFilter.beneficiary}
                      onChange={e => setTxFilter(f => ({...f, beneficiary: e.target.value, page: 0}))}
                      placeholder="María Pérez"
                      className="bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-white text-xs focus:outline-none focus:border-green-500"/>
                  </div>
                  <div>
                    <label className="text-gray-500 text-xs block mb-1">Ref. operación</label>
                    <input value={txFilter.operationRef}
                      onChange={e => setTxFilter(f => ({...f, operationRef: e.target.value, page: 0}))}
                      placeholder="998877…"
                      className="bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-white text-xs focus:outline-none focus:border-green-500"/>
                  </div>
                  <div>
                    <label className="text-gray-500 text-xs block mb-1">Buscar ID/Ref</label>
                    <input value={txSearch} onChange={e => setTxSearch(e.target.value)}
                      onKeyDown={e => e.key === "Enter" && fetchTxDetail(txSearch)}
                      className="bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-white text-xs focus:outline-none focus:border-green-500"
                      placeholder="42 o A3F9B2C1…"/>
                  </div>
                  <div className="flex gap-2">
                    <button onClick={() => fetchTransactions()}
                      className="flex items-center gap-1 px-3 py-1.5 bg-green-600/20 border border-green-500/30 rounded-lg text-green-400 text-xs hover:bg-green-600/30 transition-colors">
                      <Filter size={12}/> Filtrar
                    </button>
                    <button onClick={() => txSearch && fetchTxDetail(txSearch)}
                      className="flex items-center gap-1 px-3 py-1.5 bg-blue-600/20 border border-blue-500/30 rounded-lg text-blue-400 text-xs hover:bg-blue-600/30 transition-colors">
                      <Eye size={12}/> Detalle
                    </button>
                  </div>
                </div>

                {/* Detail modal */}
                {txDetail && (
                  <div className="bg-gray-900 border border-green-500/30 rounded-xl p-4">
                    <div className="flex justify-between items-center mb-3">
                      <span className="text-green-400 font-bold text-sm">Detalle: {txDetail.operationRef}</span>
                      <button onClick={() => setTxDetail(null)} className="text-gray-500 hover:text-white"><XCircle size={16}/></button>
                    </div>
                    <pre className="text-xs text-gray-300 overflow-x-auto">{JSON.stringify(txDetail, null, 2)}</pre>
                  </div>
                )}

                {/* Table */}
                {txLoading ? (
                  <div className="text-center py-10 text-gray-500 text-sm">
                    <RefreshCw size={20} className="animate-spin mx-auto mb-2"/>Cargando…
                  </div>
                ) : txList.length === 0 ? (
                  <div className="bg-gray-900 border border-gray-800 rounded-xl p-8 text-center text-gray-500 text-sm">
                    Sin datos — usa <strong>Filtrar</strong> o verifica que el servicio P2P esté UP.
                  </div>
                ) : (
                  <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
                    <table className="w-full text-xs">
                      <thead className="bg-gray-800/60">
                        <tr>
                          {["ID","Ref","Tipo","Estado","Monto","Beneficiario","Fecha","Reconciliación",""].map(h => (
                            <th key={h} className="px-3 py-2.5 text-left text-gray-400 font-semibold">{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {txList.map((tx, i) => (
                          <tr key={tx.id ?? i} className="border-t border-gray-800/60 hover:bg-gray-800/30 transition-colors">
                            <td className="px-3 py-2.5 text-gray-400">{tx.id}</td>
                            <td className="px-3 py-2.5 text-gray-300 font-mono">{tx.operationRef?.slice(0,12)}…</td>
                            <td className="px-3 py-2.5 text-blue-400">{tx.type}</td>
                            <td className="px-3 py-2.5">
                              <span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${txStatusColor(tx.status)}`}>
                                {tx.status}
                              </span>
                            </td>
                            <td className="px-3 py-2.5 text-white font-bold">{tx.amount?.toLocaleString("es-VE")}</td>
                            <td className="px-3 py-2.5 text-gray-300">{tx.name ?? "—"}</td>
                            <td className="px-3 py-2.5 text-gray-500">{tx.createdAt?.slice(0,16).replace("T"," ")}</td>
                            <td className="px-3 py-2.5">
                              {tx.reconciliationAttempts ? (
                                <span title={tx.lastReconciliationAt ? `Última consulta a BNC: ${tx.lastReconciliationAt.slice(0,16).replace("T"," ")}` : "Aún no se ha consultado a BNC"}
                                  className="px-2 py-0.5 rounded-full text-xs font-semibold bg-yellow-500/20 text-yellow-400 border border-yellow-500/40">
                                  {tx.reconciliationAttempts} intento{tx.reconciliationAttempts === 1 ? "" : "s"}
                                </span>
                              ) : (
                                <span className="text-gray-600">—</span>
                              )}
                            </td>
                            <td className="px-3 py-2.5">
                              <button onClick={() => fetchTxDetail(String(tx.id))}
                                className="text-gray-500 hover:text-green-400 transition-colors">
                                <ChevronRight size={14}/>
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {/* Pagination */}
                    <div className="p-3 border-t border-gray-800 flex gap-2 justify-end">
                      <button disabled={txFilter.page === 0}
                        onClick={() => setTxFilter(f => ({...f, page: f.page - 1}))}
                        className="px-3 py-1 text-xs bg-gray-800 rounded disabled:opacity-40 text-gray-300 hover:bg-gray-700">
                        ← Anterior
                      </button>
                      <span className="text-gray-500 text-xs px-2 py-1">Pág {txFilter.page + 1}</span>
                      <button onClick={() => setTxFilter(f => ({...f, page: f.page + 1}))}
                        className="px-3 py-1 text-xs bg-gray-800 rounded text-gray-300 hover:bg-gray-700">
                        Siguiente →
                      </button>
                    </div>
                  </div>
                )}

                {/* Bar chart */}
                <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
                  <div className="text-xs text-gray-400 mb-3 font-bold uppercase tracking-widest">Distribución horaria</div>
                  <ResponsiveContainer width="100%" height={160}>
                    <BarChart data={hourly}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#1f2937"/>
                      <XAxis dataKey="hour" tick={{ fill: "#6b7280", fontSize: 9 }} interval={5}/>
                      <YAxis tick={{ fill: "#6b7280", fontSize: 9 }}/>
                      <Tooltip contentStyle={{ background: "#111827", border: "1px solid #374151", borderRadius: 8, fontSize: 11 }}/>
                      <Bar dataKey="ok"    fill="#22c55e" name="OK"    radius={[3,3,0,0]}/>
                      <Bar dataKey="error" fill="#ef4444" name="Error" radius={[3,3,0,0]}/>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>
            )}

            {/* ══════════ CORRELACIÓN P2P ↔ WEBHOOK ══════════ */}
            {activeTab === "webhookcorr" && (
              <div className="space-y-4">
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <h2 className="text-white font-bold text-base flex items-center gap-2">
                    <Webhook size={16} className="text-green-400"/> Correlación Webhook
                  </h2>
                  <button onClick={() => { fetchTransactions(); fetchWebhookAudits(); }} disabled={txLoading || webhookCorrLoading}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-green-600 hover:bg-green-500 rounded-lg text-white text-xs font-semibold transition-colors disabled:opacity-50">
                    <RefreshCw size={13} className={(txLoading || webhookCorrLoading) ? "animate-spin" : ""}/>
                    Actualizar
                  </button>
                </div>

                {txList.length === 0 && (
                  <div className="bg-yellow-500/5 border border-yellow-500/20 rounded-xl p-3 flex items-start gap-2.5 text-xs text-gray-400">
                    <AlertTriangle size={15} className="text-yellow-400 flex-shrink-0 mt-0.5"/>
                    <div>
                      No hay transacciones P2P cargadas todavía — normalmente porque{" "}
                      <strong className="text-gray-300">GET /api/transactions</strong> (msvc-p2p) sigue devolviendo
                      HTTP 500 en producción (hallazgo pendiente). El cruce con el historial de webhooks
                      (<strong className="text-gray-300">GET /api/v1/audit</strong>, que sí funciona) se arma
                      automáticamente en cuanto haya transacciones P2P que correlacionar.
                    </div>
                  </div>
                )}
                {webhookCorrError && (
                  <div className="bg-red-500/5 border border-red-500/20 rounded-xl p-3 flex items-start gap-2.5 text-xs text-red-300">
                    <AlertTriangle size={15} className="text-red-400 flex-shrink-0 mt-0.5"/>
                    <div>No se pudo cargar el historial de webhooks: {webhookCorrError}</div>
                  </div>
                )}

                <div className="flex flex-wrap gap-4 text-xs text-gray-500 px-1">
                  <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-green-500"/> Webhook confirmado</span>
                  <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-yellow-500"/> Pendiente (dentro de la ventana de espera)</span>
                  <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-red-500"/> No recibido (superó la ventana)</span>
                  <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-gray-500"/> N/A — el P2P no fue exitoso</span>
                </div>

                {webhookCorrRows.length === 0 ? (
                  <div className="bg-gray-900 border border-gray-800 rounded-xl p-8 text-center text-gray-500 text-sm">
                    Sin transacciones P2P para correlacionar todavía.
                  </div>
                ) : (
                  <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
                    <table className="w-full text-xs">
                      <thead className="bg-gray-800/60">
                        <tr>
                          {["Referencia","Beneficiario","Monto","P2P procesado","Estado P2P","Estado Webhook","Webhook recibido","Latencia"].map(h => (
                            <th key={h} className="px-3 py-2.5 text-left text-gray-400 font-semibold whitespace-nowrap">{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {webhookCorrRows.map(row => {
                          const badge = webhookCorrBadge(row.webhookStatus);
                          return (
                            <tr key={row.operationRef} className="border-t border-gray-800/60 hover:bg-gray-800/30 transition-colors">
                              <td className="px-3 py-2.5 text-gray-300 font-mono whitespace-nowrap">{row.operationRef}</td>
                              <td className="px-3 py-2.5 text-gray-300">
                                {row.beneficiaryName}
                                <div className="text-gray-600">{row.beneficiaryId}</div>
                              </td>
                              <td className="px-3 py-2.5 text-white font-bold whitespace-nowrap">Bs. {row.amount.toLocaleString("es-VE")}</td>
                              <td className="px-3 py-2.5 text-gray-500 whitespace-nowrap">{row.p2pAt.slice(11,19)}</td>
                              <td className="px-3 py-2.5">
                                <span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${txStatusColor(row.p2pStatus)}`}>
                                  {row.p2pStatus}
                                </span>
                              </td>
                              <td className="px-3 py-2.5">
                                <span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${badge.className}`}>
                                  {badge.label}
                                </span>
                              </td>
                              <td className="px-3 py-2.5 text-gray-500 whitespace-nowrap">
                                {row.webhookAt ? row.webhookAt.slice(11,19) : "—"}
                              </td>
                              <td className="px-3 py-2.5 text-gray-400 whitespace-nowrap">
                                {row.latencyMs != null ? `${(row.latencyMs / 1000).toFixed(1)}s` : "—"}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}

                <div className="text-gray-600 text-xs px-1">
                  {webhookCorrRows.length} transaccion(es) P2P · cruce por número de referencia (operationRef) contra {webhookAudits.length} registro(s) de auditoría de webhooks.
                </div>
              </div>
            )}

            {/* ══════════ P2P / WEBHOOKS ══════════ */}
            {activeTab === "p2p" && (
              <div className="space-y-4">
                <h2 className="text-white font-bold text-base flex items-center gap-2">
                  <ArrowLeftRight size={16} className="text-green-400"/> P2P &amp; Webhooks
                </h2>

                <div className="grid md:grid-cols-2 gap-4">
                  {/* P2P Form */}
                  <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 space-y-3">
                    <div className="flex items-center gap-2 mb-2">
                      <Send size={14} className="text-blue-400"/>
                      <span className="text-white font-semibold text-sm">Enviar P2P</span>
                      <span className="text-xs text-gray-500 ml-auto">POST /api/v1/payments/p2p</span>
                    </div>
                    {(["Amount","BeneficiaryBankCode","BeneficiaryCellPhone","BeneficiaryEmail","BeneficiaryID","BeneficiaryName","Description"] as Array<keyof typeof p2pForm>).map(field => (
                      <div key={field}>
                        <label className="text-gray-500 text-xs block mb-0.5">{field}</label>
                        <input value={p2pForm[field]} onChange={e => setP2pForm(f => ({...f, [field]: e.target.value}))}
                          className="w-full bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-white text-xs focus:outline-none focus:border-blue-500"/>
                      </div>
                    ))}
                    <button onClick={sendP2P} disabled={p2pLoading}
                      className="w-full flex items-center justify-center gap-2 py-2 bg-blue-600 hover:bg-blue-500 rounded-lg text-white text-xs font-bold transition-colors disabled:opacity-50">
                      <Play size={13} className={p2pLoading ? "animate-pulse" : ""}/>
                      {p2pLoading ? "Enviando…" : "Enviar P2P"}
                    </button>
                    {p2pResult && (
                      <div className="relative">
                        <button onClick={() => navigator.clipboard.writeText(p2pResult)}
                          className="absolute top-1 right-1 text-gray-500 hover:text-white">
                          <Copy size={12}/>
                        </button>
                        <pre className={`text-xs rounded-lg p-3 overflow-x-auto ${p2pResult.startsWith("ERROR") ? "bg-red-950/50 text-red-300 border border-red-900" : "bg-gray-800 text-green-300"}`}>
                          {p2pResult}
                        </pre>
                      </div>
                    )}
                  </div>

                  {/* Webhook Form */}
                  <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 space-y-3">
                    <div className="flex items-center gap-2 mb-2">
                      <Bell size={14} className="text-purple-400"/>
                      <span className="text-white font-semibold text-sm">Disparar Webhook</span>
                      <span className="text-xs text-gray-500 ml-auto">POST /api/v1/webhooks/notification</span>
                    </div>
                    {(Object.keys(whForm) as Array<keyof typeof whForm>).map(field => (
                      <div key={field}>
                        <label className="text-gray-500 text-xs block mb-0.5">{field}</label>
                        <input value={whForm[field]} onChange={e => setWhForm(f => ({...f, [field]: e.target.value}))}
                          className="w-full bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-white text-xs focus:outline-none focus:border-purple-500"/>
                      </div>
                    ))}
                    <button onClick={sendWebhook} disabled={whLoading}
                      className="w-full flex items-center justify-center gap-2 py-2 bg-purple-600 hover:bg-purple-500 rounded-lg text-white text-xs font-bold transition-colors disabled:opacity-50">
                      <Send size={13} className={whLoading ? "animate-pulse" : ""}/>
                      {whLoading ? "Enviando…" : "Disparar Webhook"}
                    </button>
                    {whResult && (
                      <div className="relative">
                        <button onClick={() => navigator.clipboard.writeText(whResult)}
                          className="absolute top-1 right-1 text-gray-500 hover:text-white">
                          <Copy size={12}/>
                        </button>
                        <pre className={`text-xs rounded-lg p-3 overflow-x-auto ${whResult.startsWith("ERROR") ? "bg-red-950/50 text-red-300 border border-red-900" : "bg-gray-800 text-purple-300"}`}>
                          {whResult}
                        </pre>
                      </div>
                    )}
                  </div>
                </div>

                {/* P2P Actuator Refresh */}
                <div className="bg-gray-900 border border-yellow-500/20 rounded-xl p-4">
                  <div className="flex items-center gap-2 mb-3">
                    <RotateCcw size={14} className="text-yellow-400"/>
                    <span className="text-white font-semibold text-sm">Actuator Refresh — P2P Service</span>
                    <span className="text-xs text-gray-500 ml-auto">POST /actuator/refresh</span>
                  </div>
                  <p className="text-gray-500 text-xs mb-3">
                    Recarga en caliente las propiedades del Config Server en el microservicio P2P sin reinicio.
                  </p>
                  <button onClick={triggerP2PRefresh} disabled={refreshLoading}
                    className="flex items-center gap-2 px-4 py-2 bg-yellow-600/20 hover:bg-yellow-600/30 border border-yellow-500/40 rounded-lg text-yellow-400 text-xs font-bold transition-colors disabled:opacity-50">
                    <RotateCcw size={13} className={refreshLoading ? "animate-spin" : ""}/>
                    {refreshLoading ? "Refreshing…" : "Trigger Refresh"}
                  </button>
                  {refreshResult && (
                    <pre className={`mt-3 text-xs rounded-lg p-3 overflow-x-auto ${refreshResult.startsWith("ERROR") ? "bg-red-950/50 text-red-300 border border-red-900" : "bg-gray-800 text-yellow-300"}`}>
                      {refreshResult}
                    </pre>
                  )}
                </div>
              </div>
            )}

            {/* ══════════ CONFIG SERVER ══════════ */}
            {activeTab === "config" && (
              <div className="space-y-4">
                <h2 className="text-white font-bold text-base flex items-center gap-2">
                  <Settings size={16} className="text-green-400"/> Config Server
                </h2>

                <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 space-y-3">
                  <p className="text-gray-400 text-xs">
                    Consulta la configuración del microservicio <code className="text-green-400">msvc-webhooks</code> por perfil de entorno.
                  </p>
                  <div className="flex items-center gap-3 flex-wrap">
                    <div>
                      <label className="text-gray-500 text-xs block mb-1">Perfil</label>
                      <select value={configEnv} onChange={e => setConfigEnv(e.target.value as "default"|"staging"|"prod")}
                        className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-white text-xs focus:outline-none focus:border-green-500">
                        <option value="default">default</option>
                        <option value="staging">staging</option>
                        <option value="prod">prod</option>
                      </select>
                    </div>
                    <button onClick={loadConfig} disabled={configLoading}
                      className="mt-4 flex items-center gap-1.5 px-3 py-1.5 bg-green-600 hover:bg-green-500 rounded-lg text-white text-xs font-bold transition-colors disabled:opacity-50">
                      <Database size={13} className={configLoading ? "animate-pulse" : ""}/>
                      {configLoading ? "Cargando…" : "Cargar Config"}
                    </button>
                  </div>
                  <div className="text-xs text-gray-600">
                    URL: {ENDPOINTS.config[`webhooks${configEnv.charAt(0).toUpperCase() + configEnv.slice(1)}` as keyof typeof ENDPOINTS.config]}
                  </div>

                  {configData && (
                    <div className="relative">
                      <button onClick={() => navigator.clipboard.writeText(configData)}
                        className="absolute top-2 right-2 text-gray-500 hover:text-white flex items-center gap-1 text-xs">
                        <Copy size={12}/> Copiar
                      </button>
                      <pre className="text-xs bg-gray-950 text-green-300 rounded-xl p-4 overflow-x-auto max-h-96 border border-gray-800">
                        {configData}
                      </pre>
                    </div>
                  )}
                </div>

                {/* Config Refresh */}
                <div className="bg-gray-900 border border-orange-500/20 rounded-xl p-4">
                  <div className="flex items-center gap-2 mb-2">
                    <RotateCcw size={14} className="text-orange-400"/>
                    <span className="text-white font-semibold text-sm">Config Server Actuator Refresh</span>
                  </div>
                  <p className="text-gray-500 text-xs mb-3">
                    Ejecuta <code className="text-orange-400">/actuator/refresh</code> en el Config Server:{" "}
                    <span className="text-gray-600">{ENDPOINTS.health.configRefresh}</span>
                  </p>
                  <button onClick={async () => {
                    addLog("INFO", "Config Server refresh…");
                    try {
                      const res = await fetch(ENDPOINTS.health.configRefresh, { method: "GET", signal: AbortSignal.timeout(10000) });
                      addLog(res.ok ? "OK" : "WARN", `Config refresh: HTTP ${res.status}`);
                    } catch (e: unknown) {
                      addLog("ERROR", e instanceof Error ? e.message : "Error");
                    }
                  }}
                    className="flex items-center gap-2 px-4 py-2 bg-orange-600/20 hover:bg-orange-600/30 border border-orange-500/40 rounded-lg text-orange-400 text-xs font-bold transition-colors">
                    <RotateCcw size={13}/> Refresh Config Server
                  </button>
                </div>
              </div>
            )}

            {/* ══════════ LOGS ══════════ */}
            {activeTab === "logs" && (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <h2 className="text-white font-bold text-base flex items-center gap-2">
                    <Terminal size={16} className="text-green-400"/> Activity Log
                  </h2>
                  <button onClick={() => setLogs([])}
                    className="text-xs text-gray-500 hover:text-red-400 transition-colors">
                    Limpiar
                  </button>
                </div>
                <div className="bg-gray-950 border border-gray-800 rounded-xl p-4 h-[60vh] overflow-y-auto font-mono text-xs space-y-1">
                  {logs.length === 0 && (
                    <span className="text-gray-600">Sin actividad aún. Ejecuta un Check All o carga transacciones.</span>
                  )}
                  {logs.map((l, i) => (
                    <div key={i} className="flex gap-2">
                      <span className="text-gray-600 flex-shrink-0">{l.ts}</span>
                      <span className={`flex-shrink-0 font-bold ${
                        l.level === "OK"    ? "text-green-400" :
                        l.level === "ERROR" ? "text-red-400"   :
                        l.level === "WARN"  ? "text-yellow-400":
                        "text-blue-400"
                      }`}>[{l.level}]</span>
                      <span className="text-gray-300">{l.message}</span>
                    </div>
                  ))}
                  <div ref={logsEndRef}/>
                </div>
              </div>
            )}

          </div>
        </main>
      </div>
    </div>
  );
}
