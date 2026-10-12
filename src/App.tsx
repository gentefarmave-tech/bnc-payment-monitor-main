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
  ChevronRight, CreditCard,
  Home, LogOut, Menu, Moon, RefreshCw,
  Sun, XCircle, Zap, Copy,
  ArrowLeftRight, Clock, Filter, Layers, Send,
  RotateCcw, Wifi, WifiOff, Eye, EyeOff, Terminal,
  Play, Shield, Webhook, Loader2,
} from "lucide-react";
import {
  describeAuditEvent, WEBHOOK_OK_STATUSES, WEBHOOK_BAD_STATUSES,
  type WebhookAudit, type EventLevel,
} from "./eventos";
import {
  api, login, fetchFeatures, getSession, clearSession, setUnauthorizedHandler,
  type Features,
} from "./api";

// ─────────────────────────────────────────────────────────────
// El panel solo habla con monitor-api (ver ./api.ts). Ya no conoce URLs de
// microservicios, ni del Config Server, ni credenciales del banco.
// ─────────────────────────────────────────────────────────────
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

// ─────────────────────────────────────────────────────────────
// TIPOS
// ─────────────────────────────────────────────────────────────
type ServiceStatus = "UP" | "DOWN" | "LOADING" | "UNKNOWN";

interface ServiceHealth {
  name: string;
  key: string;
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
type WebhookCorrStatus = "RECEIVED" | "PENDING" | "MISSING" | "INVALID" | "NA";

interface WebhookCorrelationRow {
  operationRef: string;
  beneficiaryName: string;
  beneficiaryId: string;
  amount: number;
  bankCode: number;
  p2pStatus: string;
  p2pAt: string;
  webhookStatus: WebhookCorrStatus;
  webhookAt: string | null;
  latencyMs: number | null;
  webhookNote: string | null;
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

      // El cierre de la notificacion es el evento terminal MAS RECIENTE
      // (matches viene ordenado de mas nuevo a mas viejo): si el banco reenvia
      // la notificacion corregida, el SUCCESS posterior le gana al ERROR previo.
      const terminal = matches.find(a => WEBHOOK_OK_STATUSES.includes(a.status) || WEBHOOK_BAD_STATUSES.includes(a.status));
      const inFlight = matches.find(a => a.status === "WEBHOOK_PROCESSING" || a.status === "WEBHOOK_RECEIVED");

      let webhookStatus: WebhookCorrStatus;
      let webhookAt: string | null = null;
      let latencyMs: number | null = null;
      let webhookNote: string | null = null;

      if (tx.status === "FAILED") {
        webhookStatus = "NA";
      } else if (terminal && WEBHOOK_OK_STATUSES.includes(terminal.status)) {
        webhookStatus = "RECEIVED";
        webhookAt = terminal.timestamp;
        latencyMs = new Date(terminal.timestamp).getTime() - new Date(tx.createdAt).getTime();
      } else if (terminal) {
        // Llego, pero fue rechazada: NO es lo mismo que "no llego" ni que "pago fallido".
        webhookStatus = "INVALID";
        webhookAt = terminal.timestamp;
        const ex = describeAuditEvent(terminal);
        webhookNote = ex.why ?? ex.title;
      } else if (inFlight) {
        webhookStatus = "PENDING";
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
        // Mismo estado que la pestaña Transacciones (viene de la BD), sin reinterpretarlo.
        p2pStatus: tx.status,
        p2pAt: tx.createdAt,
        webhookStatus,
        webhookAt,
        latencyMs,
        webhookNote,
      };
      return row;
    });
}

function webhookCorrBadge(status: WebhookCorrStatus): { label: string; className: string } {
  switch (status) {
    case "RECEIVED": return { label: "Recibido",    className: "bg-green-500/15 text-green-400" };
    case "PENDING":  return { label: "Pendiente",   className: "bg-yellow-500/15 text-yellow-400" };
    case "MISSING":  return { label: "No recibido", className: "bg-red-500/15 text-red-400" };
    case "INVALID":  return { label: "Rechazado (dato inválido)", className: "bg-orange-500/15 text-orange-400" };
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

// ─────────────────────────────────────────────────────────────
// RECONCILIATION — poll dedicado con mas detalle (DLQ / incidentes)
// ─────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────
// INITIAL SERVICE LIST
// ─────────────────────────────────────────────────────────────
const INITIAL_SERVICES: ServiceHealth[] = [
  { name: "Eureka Server",         key: "eureka",         status: "UNKNOWN", latencyMs: null, lastChecked: null, detail: "—" },
  { name: "Config Server",         key: "configServer",   status: "UNKNOWN", latencyMs: null, lastChecked: null, detail: "—" },
  { name: "Webhooks Service",      key: "webhooks",       status: "UNKNOWN", latencyMs: null, lastChecked: null, detail: "—" },
  { name: "P2P Service",           key: "p2p",            status: "UNKNOWN", latencyMs: null, lastChecked: null, detail: "—" },
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
  const [activeTab, setActiveTab]   = useState<"overview" | "health" | "transactions" | "webhookcorr" | "p2p" | "webhooks" | "logs">("overview");
  const [authed, setAuthed]         = useState<boolean>(() => !!getSession());
  const [features, setFeatures]     = useState<Features>({ p2p: false, webhook: false });
  const [whPrefilling, setWhPrefilling] = useState(false);
  const [whPrefillNote, setWhPrefillNote] = useState("");
  const [autoFillWebhook, setAutoFillWebhook] = useState(true);
  const [loginBusy, setLoginBusy]   = useState(false);
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

  // Refresh P2P
  const [refreshResult, setRefreshResult] = useState("");
  const [refreshLoading, setRefreshLoading] = useState(false);

  // Actividad de pagos (log legible para el usuario de la pasarela)
  const [logView, setLogView]           = useState<"pagos" | "panel">("pagos");
  const [onlyProblems, setOnlyProblems] = useState(false);
  const [logSearch, setLogSearch]       = useState("");
  const [showTech, setShowTech]         = useState(false);

  // Logs (sesion del panel)
  const [logs, setLogs]             = useState<LogEntry[]>([]);
  const logsEndRef                  = useRef<HTMLDivElement>(null);

  const addLog = useCallback((level: LogEntry["level"], message: string) => {
    setLogs(prev => [...prev.slice(-199), { ts: now(), level, message }]);
  }, []);

  // ── Auth ────────────────────────────────────────────────
  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoginErr("");
    setLoginBusy(true);
    try {
      const sess = await login(loginUser.trim(), loginPass);
      setLoginPass("");
      setFeatures(await fetchFeatures());
      setAuthed(true);
      addLog("OK", `Sesión iniciada como ${sess.username} (${sess.role})`);
    } catch (err: unknown) {
      setLoginErr(err instanceof Error ? err.message : "No se pudo iniciar sesión");
    }
    setLoginBusy(false);
  };

  const handleLogout = useCallback(() => {
    clearSession();
    setAuthed(false);
    setFeatures({ p2p: false, webhook: false });
  }, []);

  // Si el token vence o el servidor lo rechaza, volver al login.
  useEffect(() => {
    setUnauthorizedHandler(() => { handleLogout(); setLoginErr("La sesión expiró. Ingresa de nuevo."); });
    return () => setUnauthorizedHandler(null);
  }, [handleLogout]);

  // Al recargar la pagina con sesion vigente, recuperar que acciones de prueba estan habilitadas.
  useEffect(() => {
    if (authed) fetchFeatures().then(setFeatures);
  }, [authed]);

  // ── Salud de servicios: UNA llamada a monitor-api (el consulta por la red privada) ──
  const loadHealth = useCallback(async (silent = false) => {
    if (!silent) {
      setChecking(true);
      addLog("INFO", "Verificando todos los servicios…");
      setServices(prev => prev.map(s => ({ ...s, status: "LOADING" as ServiceStatus })));
    }
    try {
      const res = await api("/api/health/services");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const list: Array<{ key: string; status: ServiceStatus; detail: string; latencyMs: number | null; extra?: Record<string, unknown> }> = data.services ?? [];
      setServices(prev => prev.map(s => {
        const r = list.find(x => x.key === s.key);
        return r ? { ...s, status: r.status, detail: r.detail ?? "—", latencyMs: r.latencyMs, lastChecked: new Date() } : s;
      }));
      const rec = list.find(x => x.key === "reconciliation");
      if (rec) {
        const e = rec.extra ?? {};
        setReconInfo({
          status: typeof e.status === "string" ? e.status : (rec.status === "UP" ? "GREEN" : "UNKNOWN"),
          dlqMessagesPending: typeof e.dlqMessagesPending === "number" ? e.dlqMessagesPending : null,
          connectionStatus: typeof e.connectionStatus === "string" ? e.connectionStatus : null,
          unresolvedIncidents: typeof e.unresolvedIncidents === "number" ? e.unresolvedIncidents : null,
          latencyMs: rec.latencyMs ?? 0,
          lastChecked: new Date(),
          error: rec.status === "DOWN" && !rec.extra ? rec.detail : null,
        });
      }
      if (!silent) list.forEach(r => addLog(r.status === "UP" ? "OK" : "ERROR", `${r.key}: ${r.status} (${r.latencyMs ?? "—"}ms — ${r.detail})`));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Error";
      setServices(prev => prev.map(s => ({ ...s, status: "DOWN" as ServiceStatus, detail: msg.slice(0, 60), lastChecked: new Date() })));
      setReconInfo(prev => ({ status: "UNKNOWN", dlqMessagesPending: null, connectionStatus: null, unresolvedIncidents: null, latencyMs: 0, lastChecked: new Date(), error: msg.slice(0, 80), ...(prev ? {} : {}) }));
      if (!silent) addLog("ERROR", `Health check: ${msg}`);
    }
    if (!silent) { setChecking(false); addLog("INFO", "Health check completado."); }
  }, [addLog]);

  const checkAll = useCallback(() => loadHealth(false), [loadHealth]);

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
        api(`/api/transactions?${params}`),
        api("/api/transactions/summary"),
        api("/api/transactions/hourly"),
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
      // Auditoría de webhooks + errores del propio P2P (rechazos del banco, inciertos): viven en tablas distintas.
      const [res, p2pRes] = await Promise.all([
        api(`/api/audit?${params}`),
        api("/api/p2p-audit").catch(() => null),
      ]);
      if (res.ok) {
        const data = await res.json();
        const webhookPart: WebhookAudit[] = data.content ?? data ?? [];
        let p2pPart: WebhookAudit[] = [];
        if (p2pRes && p2pRes.ok) {
          const d = await p2pRes.json();
          p2pPart = d.content ?? [];
        }
        const content = [...webhookPart, ...p2pPart];
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
  // Si el disparador de webhook esta habilitado en monitor-api, al terminar el pago se
  // precargan los datos del webhook con lo que devolvio el banco (referencia, monto, fecha, hora…)
  // para simular la notificacion real sin transcribir nada a mano.
  const prefillWebhookFrom = async (amount: number, bankReference: string, input: typeof p2pForm) => {
    setWhPrefilling(true);
    setWhPrefillNote("");
    await sleep(1300); // efecto de carga: se ve que el panel "recibe" los datos del banco
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const digits = input.BeneficiaryCellPhone.replace(/\D/g, "");
    setWhForm(f => ({
      ...f,
      OriginBankReference: bankReference,
      Amount: amount.toFixed(2),
      Hour: `${pad(d.getHours())}${pad(d.getMinutes())}`,
      Date: `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`,
      ClientPhone: digits ? `00${digits}` : f.ClientPhone,
      Concept: input.Description || f.Concept,
    }));
    setWhPrefillNote(`Datos cargados desde el pago con referencia ${bankReference}. Revísalos y pulsa "Disparar Webhook".`);
    setWhPrefilling(false);
  };

  const sendP2P = async () => {
    setP2pLoading(true);
    setP2pResult("");
    setWhPrefillNote("");
    addLog("INFO", `Enviando P2P → ${p2pForm.BeneficiaryName} (${p2pForm.Amount})`);
    try {
      const sent = { ...p2pForm };
      const amount = parseFloat(sent.Amount);
      const res = await api("/api/p2p/send", {
        method: "POST",
        body: { ...sent, Amount: amount, BeneficiaryBankCode: parseInt(sent.BeneficiaryBankCode) },
        timeoutMs: 35000,
      });
      const text = await res.text();
      setP2pResult(text);
      addLog(res.ok ? "OK" : "WARN", `P2P response: HTTP ${res.status}`);
      if (res.ok && features.webhook && autoFillWebhook) {
        let reference = "";
        try { reference = String(JSON.parse(text)?.reference ?? ""); } catch { /* respuesta no JSON */ }
        if (reference) {
          setP2pLoading(false);
          await prefillWebhookFrom(amount, reference, sent);
          return;
        }
        addLog("WARN", "El pago no devolvió referencia del banco; no se precargó el webhook.");
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Error";
      setP2pResult(`ERROR: ${msg}`);
      addLog("ERROR", msg);
    }
    setP2pLoading(false);
  };

  // ── Send Webhook (monitor-api pone las credenciales; el navegador no las ve) ──
  const sendWebhook = async () => {
    setWhLoading(true);
    setWhResult("");
    addLog("INFO", "Disparando webhook de prueba (vía monitor-api)…");
    try {
      const res = await api("/api/webhooks/test", { method: "POST", body: whForm, timeoutMs: 20000 });
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

  // ── P2P Actuator Refresh ──────────────────────────────────
  const triggerP2PRefresh = async () => {
    setRefreshLoading(true);
    setRefreshResult("");
    addLog("INFO", "Disparando actuator/refresh en P2P Service…");
    try {
      const res = await api("/api/admin/p2p/refresh", { method: "POST", timeoutMs: 20000 });
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
      const res = await api(`/api/transactions/${encodeURIComponent(id)}`);
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

  // ── Salud + conciliacion (DLQ / incidentes) cada 20s, en silencio ──
  useEffect(() => {
    if (!authed) return;
    const first = setTimeout(() => loadHealth(true), 0);
    const id = setInterval(() => loadHealth(true), 20000);
    return () => { clearTimeout(first); clearInterval(id); };
  }, [authed, loadHealth]);

  // ── Load transactions when tab opens ─────────────────────
  useEffect(() => {
    if (authed && (activeTab === "transactions" || activeTab === "overview" || activeTab === "webhookcorr" || activeTab === "logs")) {
      fetchTransactions();
    }
    if (authed && (activeTab === "webhookcorr" || activeTab === "logs")) {
      fetchWebhookAudits();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authed, activeTab]);

  // ── Correlación P2P ↔ Webhook: derivada de txList + webhookAudits ──
  const webhookCorrRows = useMemo(
    () => buildWebhookCorrelation(txList, webhookAudits),
    [txList, webhookAudits]
  );

  // ── Actividad de pagos: eventos de auditoria traducidos y enlazados a su pago ──
  const activityRows = useMemo(() => {
    const q = logSearch.trim().toLowerCase();
    return [...webhookAudits]
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
      .map(a => {
        const ex = describeAuditEvent(a);
        // Los eventos del webhook usan la referencia del banco; el de "pago iniciado" usa operationRef.
        const tx = txList.find(t => t.operationRef === a.transactionId || (!!t.referenceNumber && t.referenceNumber === a.transactionId));
        const who = tx ? `${tx.name ?? "—"} · Bs. ${tx.amount.toLocaleString("es-VE")}` : null;
        return { a, ex, tx, who };
      })
      .filter(r => !onlyProblems || r.ex.level === "error" || r.ex.level === "warn")
      .filter(r => !q || [r.a.transactionId, r.tx?.operationRef, r.tx?.referenceNumber, r.tx?.name, r.ex.title]
        .some(v => (v ?? "").toLowerCase().includes(q)));
  }, [webhookAudits, txList, onlyProblems, logSearch]);

  const levelStyle: Record<EventLevel, { dot: string; text: string }> = {
    ok:    { dot: "bg-green-500",  text: "text-green-400" },
    info:  { dot: "bg-blue-500",   text: "text-blue-400" },
    warn:  { dot: "bg-yellow-500", text: "text-yellow-400" },
    error: { dot: "bg-red-500",    text: "text-red-400" },
  };

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
            <button type="submit" disabled={loginBusy}
              className="w-full bg-green-600 hover:bg-green-500 text-white font-semibold py-2 rounded-lg text-sm transition-colors disabled:opacity-50">
              {loginBusy ? "Ingresando…" : "Ingresar"}
            </button>
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
    { id: "logs",         icon: <Terminal size={16}/>,     label: "Actividad" },
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
            <button onClick={handleLogout}
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
                          vía monitor-api
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
                      <button onClick={checkAll}
                        className="flex-shrink-0 p-2 rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-400 hover:text-white transition-colors">
                        <RefreshCw size={14}/>
                      </button>
                    </div>
                  ))}
                </div>

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
                  <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-orange-500"/> Rechazado: llegó con un dato inválido (el pago sigue en espera)</span>
                  <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-gray-500"/> N/A — el P2P falló</span>
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
                                {row.webhookNote && (
                                  <div className="text-orange-300/80 mt-1 max-w-[260px] whitespace-normal">{row.webhookNote}</div>
                                )}
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
                  {webhookCorrRows.length} transaccion(es) P2P · cruce por número de referencia del banco (referenceNumber) contra {webhookAudits.length} registro(s) de auditoría de webhooks.
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
                      <span className="text-xs text-gray-500 ml-auto">POST /api/p2p/send</span>
                    </div>
                    {!features.p2p && (
                      <div className="bg-yellow-500/10 border border-yellow-500/40 rounded-lg p-2.5 text-xs text-yellow-300">
                        El envío de pagos de prueba está desactivado en este ambiente (monitor-api: ENABLE_TEST_ACTIONS=false).
                      </div>
                    )}
                    {features.webhook && (
                      <label className="flex items-center gap-2 text-xs text-gray-400 cursor-pointer select-none">
                        <input type="checkbox" checked={autoFillWebhook} onChange={e => setAutoFillWebhook(e.target.checked)} className="accent-purple-500"/>
                        Al enviar, cargar los datos del pago en el webhook (simula la notificación del banco)
                      </label>
                    )}
                    {(["Amount","BeneficiaryBankCode","BeneficiaryCellPhone","BeneficiaryEmail","BeneficiaryID","BeneficiaryName","Description"] as Array<keyof typeof p2pForm>).map(field => (
                      <div key={field}>
                        <label className="text-gray-500 text-xs block mb-0.5">{field}</label>
                        <input value={p2pForm[field]} onChange={e => setP2pForm(f => ({...f, [field]: e.target.value}))}
                          className="w-full bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-white text-xs focus:outline-none focus:border-blue-500"/>
                      </div>
                    ))}
                    <button onClick={sendP2P} disabled={p2pLoading || whPrefilling || !features.p2p}
                      className="w-full flex items-center justify-center gap-2 py-2 bg-blue-600 hover:bg-blue-500 rounded-lg text-white text-xs font-bold transition-colors disabled:opacity-50">
                      <Play size={13} className={p2pLoading ? "animate-pulse" : ""}/>
                      {p2pLoading ? "Enviando…" : whPrefilling ? "Cargando webhook…" : "Enviar P2P"}
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

                  {/* Webhook Form — solo si monitor-api tiene ENABLE_WEBHOOK_TRIGGER=true (apagado por defecto: el incidente del 2026-09-02 fue un webhook de prueba disparado desde produccion) */}
                  {features.webhook && (
                  <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 space-y-3">
                    <div className="flex items-center gap-2 mb-2">
                      <Bell size={14} className="text-purple-400"/>
                      <span className="text-white font-semibold text-sm">Disparar Webhook</span>
                      <span className="text-xs text-gray-500 ml-auto">POST /api/webhooks/test</span>
                    </div>
                    {import.meta.env.PROD && (
                      <div className="bg-red-500/10 border border-red-500/40 rounded-lg p-2.5 flex items-start gap-2 text-xs text-red-300">
                        <AlertTriangle size={14} className="text-red-400 flex-shrink-0 mt-0.5"/>
                        <div>
                          <strong>Modo prueba en PRODUCCIÓN.</strong> Este envío genera un evento real contra el
                          webhook de producción (se audita y puede confirmar una transacción). Úsalo solo con una
                          referencia de prueba conocida.
                        </div>
                      </div>
                    )}
                    {whPrefilling && (
                      <div className="flex items-center gap-2 bg-purple-500/10 border border-purple-500/40 rounded-lg p-2.5 text-xs text-purple-300">
                        <Loader2 size={14} className="animate-spin flex-shrink-0"/>
                        Recibiendo los datos del banco… cargando el webhook.
                      </div>
                    )}
                    {!whPrefilling && whPrefillNote && (
                      <div className="flex items-start gap-2 bg-green-500/10 border border-green-500/40 rounded-lg p-2.5 text-xs text-green-300">
                        <CheckCircle2 size={14} className="flex-shrink-0 mt-0.5"/>
                        {whPrefillNote}
                      </div>
                    )}
                    {(Object.keys(whForm) as Array<keyof typeof whForm>).map(field => (
                      <div key={field}>
                        <label className="text-gray-500 text-xs block mb-0.5">{field}</label>
                        <input value={whForm[field]} disabled={whPrefilling} onChange={e => setWhForm(f => ({...f, [field]: e.target.value}))}
                          className={`w-full bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-white text-xs focus:outline-none focus:border-purple-500 ${whPrefilling ? "animate-pulse opacity-50" : ""}`}/>
                      </div>
                    ))}
                    <button onClick={sendWebhook} disabled={whLoading || whPrefilling}
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
                  )}
                </div>

                {/* P2P Actuator Refresh */}
                <div className="bg-gray-900 border border-yellow-500/20 rounded-xl p-4">
                  <div className="flex items-center gap-2 mb-3">
                    <RotateCcw size={14} className="text-yellow-400"/>
                    <span className="text-white font-semibold text-sm">Actuator Refresh — P2P Service</span>
                    <span className="text-xs text-gray-500 ml-auto">POST /api/admin/p2p/refresh</span>
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

            {/* ══════════ LOGS ══════════ */}
            {activeTab === "logs" && (
              <div className="space-y-3">
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <h2 className="text-white font-bold text-base flex items-center gap-2">
                    <Terminal size={16} className="text-green-400"/> Actividad
                  </h2>
                  <div className="flex items-center gap-2 text-xs">
                    <button onClick={() => setLogView("pagos")}
                      className={`px-3 py-1.5 rounded-lg font-semibold ${logView === "pagos" ? "bg-green-600 text-white" : "bg-gray-800 text-gray-400 hover:text-white"}`}>
                      Pagos y notificaciones
                    </button>
                    <button onClick={() => setLogView("panel")}
                      className={`px-3 py-1.5 rounded-lg font-semibold ${logView === "panel" ? "bg-green-600 text-white" : "bg-gray-800 text-gray-400 hover:text-white"}`}>
                      Sesión del panel
                    </button>
                  </div>
                </div>

                {logView === "pagos" && (
                  <>
                    <div className="flex items-center gap-2 flex-wrap text-xs">
                      <button onClick={() => { fetchTransactions(); fetchWebhookAudits(); }} disabled={txLoading || webhookCorrLoading}
                        className="flex items-center gap-1.5 px-3 py-1.5 bg-green-600 hover:bg-green-500 rounded-lg text-white font-semibold disabled:opacity-50">
                        <RefreshCw size={13} className={(txLoading || webhookCorrLoading) ? "animate-spin" : ""}/> Actualizar
                      </button>
                      <button onClick={() => setOnlyProblems(v => !v)}
                        className={`px-3 py-1.5 rounded-lg font-semibold ${onlyProblems ? "bg-red-600 text-white" : "bg-gray-800 text-gray-400 hover:text-white"}`}>
                        Solo lo que requiere atención
                      </button>
                      <button onClick={() => setShowTech(v => !v)}
                        className={`px-3 py-1.5 rounded-lg font-semibold ${showTech ? "bg-gray-600 text-white" : "bg-gray-800 text-gray-400 hover:text-white"}`}>
                        Detalle técnico (operador)
                      </button>
                      <input value={logSearch} onChange={e => setLogSearch(e.target.value)}
                        placeholder="Buscar por referencia, nombre…"
                        className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-gray-200 placeholder-gray-600 w-60"/>
                    </div>

                    {webhookCorrError && (
                      <div className="bg-red-500/5 border border-red-500/20 rounded-xl p-3 text-xs text-red-300">
                        No se pudo cargar la actividad: {webhookCorrError}
                      </div>
                    )}

                    <div className="bg-gray-900 border border-gray-800 rounded-xl divide-y divide-gray-800/60 max-h-[65vh] overflow-y-auto">
                      {activityRows.length === 0 && (
                        <div className="p-8 text-center text-gray-500 text-sm">
                          {onlyProblems ? "Sin eventos que requieran atención." : "Sin actividad registrada todavía."}
                        </div>
                      )}
                      {activityRows.map(({ a, ex, who }) => (
                        <div key={a.eventId} className="px-4 py-3 flex gap-3">
                          <span className={`mt-1.5 w-2 h-2 rounded-full flex-shrink-0 ${levelStyle[ex.level].dot}`}/>
                          <div className="min-w-0 flex-1 space-y-0.5">
                            <div className="flex items-baseline gap-2 flex-wrap">
                              <span className="text-gray-500 text-xs whitespace-nowrap">
                                {a.timestamp.slice(0, 10)} {a.timestamp.slice(11, 19)}
                              </span>
                              <span className={`text-sm font-semibold ${levelStyle[ex.level].text}`}>{ex.title}</span>
                            </div>
                            {(who || a.transactionId) && (
                              <div className="text-xs text-gray-500">
                                {who ? `${who} · ` : ""}Ref. {a.transactionId}
                              </div>
                            )}
                            {ex.why && <div className="text-xs text-gray-300">{ex.why}</div>}
                            {ex.action && <div className="text-xs text-gray-400"><strong className="text-gray-300">Qué hacer:</strong> {ex.action}</div>}
                            {showTech && ex.technical && (
                              <pre className="mt-1.5 bg-gray-950 border border-gray-800 rounded p-2 text-[10px] text-gray-500 whitespace-pre-wrap break-all">
{a.status} · {a.projectSource ?? "—"}{a.ipOrigin ? ` · ${a.ipOrigin}` : ""}{"\n"}{ex.technical}
                              </pre>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                    <div className="text-gray-600 text-xs px-1">{activityRows.length} evento(s) · más recientes primero</div>
                  </>
                )}

                {logView === "panel" && (
                  <>
                    <div className="flex justify-end">
                      <button onClick={() => setLogs([])} className="text-xs text-gray-500 hover:text-red-400 transition-colors">
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
                  </>
                )}
              </div>
            )}

          </div>
        </main>
      </div>
    </div>
  );
}
