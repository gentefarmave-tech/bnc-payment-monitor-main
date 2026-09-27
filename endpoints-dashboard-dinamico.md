# Endpoints Requeridos — BNC Payment Monitor Dashboard Dinámico

> **Contexto:** El frontend (`App.tsx`) actualmente usa datos mock hardcodeados. Este documento describe todos los endpoints REST y WebSocket que el backend en Railway debe exponer para que el dashboard opere con datos reales.

---

## Arquitectura General

```
Frontend (React)
      │
      ▼
Backend Railway (Express/Node) ◄──► BNC ESolutions API v4.1
      │                        ◄──► RabbitMQ Broker
      │                        ◄──► Supabase (histórico)
      ▼
  Dashboard en tiempo real
```

> El frontend **nunca llama directo** a la BNC API ni a RabbitMQ. Railway actúa como proxy seguro. Supabase almacena el historial de webhooks y transacciones.

---

## 🔴 CRÍTICOS — Bloquean funcionalidad core

### 1. Overview / KPI Cards

| Método | Endpoint | Descripción |
|--------|----------|-------------|
| `GET` | `/api/overview` | Devuelve los 5 KPI cards: webhooks hoy, P2P OK, P2P fallidas, DLQ count, latencia promedio |
| `GET` | `/api/alerts` | Alertas activas: DLQ alto, latencia degradada, servicio caído |
| `WS` | `ws://…/dashboard/live` | Push en tiempo real de actualizaciones para todos los KPIs del overview |

**Respuesta esperada `/api/overview`:**
```json
{
  "webhooksToday": 142,
  "p2pSuccess": 118,
  "p2pFailed": 24,
  "dlqCount": 3,
  "avgLatencyMs": 287
}
```

---

### 2. Webhooks / Notificaciones BNC Push V2

| Método | Endpoint | Descripción |
|--------|----------|-------------|
| `GET` | `/api/webhooks/recent` | Lista paginada de notificaciones recibidas (P2P, C2P, TRF, DEP) con payload completo |
| `GET` | `/api/webhooks/stats` | Totales por hora: recibidos, exitosos, fallidos (para gráfica de barras) |
| `WS` | `ws://…/webhooks/live` | Stream en tiempo real de nuevas notificaciones BNC Push V2 |

**Query params `/api/webhooks/recent`:**
```
?type=P2P|C2P|TRF|DEP
&page=1
&limit=20
&from=2026-05-17T00:00:00Z
&to=2026-05-17T23:59:59Z
```

---

### 3. Transacciones P2P / C2P / TRF

| Método | Endpoint | Descripción |
|--------|----------|-------------|
| `GET` | `/api/transactions` | Historial con filtros: tipo, estado, rango de fechas, monto |
| `GET` | `/api/transactions/summary` | KPIs: total hoy, exitosas, fallidas, monto total procesado |
| `GET` | `/api/transactions/hourly` | Serie de tiempo por hora para gráficas de área (OK vs Error, últimas 24h) |

**Respuesta esperada `/api/transactions/hourly`:**
```json
[
  { "hour": "00:00", "ok": 4, "error": 1 },
  { "hour": "01:00", "ok": 7, "error": 0 },
  ...
]
```

---

### 4. RabbitMQ — Cola & Dead Letter Queue

| Método | Endpoint | Descripción |
|--------|----------|-------------|
| `GET` | `/api/rabbitmq/queues` | Estado de colas: mensajes pendientes, tasa de consumo |
| `GET` | `/api/rabbitmq/dlq` | Mensajes en Dead Letter Queue: conteo, payload, motivo de falla |
| `POST` | `/api/rabbitmq/dlq/retry` | Re-encolar mensajes fallidos desde el dashboard |

**Respuesta esperada `/api/rabbitmq/dlq`:**
```json
{
  "count": 3,
  "messages": [
    {
      "id": "msg-001",
      "payload": { ... },
      "reason": "NACK - timeout",
      "timestamp": "2026-05-17T14:32:00Z"
    }
  ]
}
```

---

## 🟡 IMPORTANTES — Enriquecen el dashboard

### 5. Servidores — Salud de Servicios

| Método | Endpoint | Descripción |
|--------|----------|-------------|
| `GET` | `/api/health` | Estado agregado de todos los servicios (BNC API, Railway, RabbitMQ) |
| `GET` | `/api/health/latency` | Latencia promedio por servicio para la gráfica de tendencia |
| `GET` | `/api/health/uptime` | Porcentaje de uptime por servicio (últimas 24h / 7 días) |

**Servicios monitoreados:**
- BNC API Auth / Logon
- BNC P2P SendP2P
- BNC C2P SendC2P
- Webhook Receiver
- Railway App Server
- RabbitMQ Broker
- Dead Letter Queue

**Respuesta esperada `/api/health`:**
```json
{
  "services": [
    {
      "name": "BNC API Auth",
      "status": "healthy",
      "latencyMs": 210,
      "uptimePercent": 99.8
    },
    ...
  ]
}
```

---

### 6. Railway — Deployments

| Método | Endpoint | Descripción |
|--------|----------|-------------|
| `GET` | `/api/railway/deployments` | Estado de staging y producción: versión, tiempo de build, commit hash |
| `GET` | `/api/railway/metrics` | CPU, memoria y tráfico de las instancias Railway activas |

---

### 7. Autenticación — Supabase / JWT

| Método | Endpoint | Descripción |
|--------|----------|-------------|
| `POST` | `/auth/v1/token` | Login con email/password vía Supabase Auth (reemplaza mock `admin/bnc2026`) |
| `POST` | `/auth/v1/logout` | Invalidar sesión actual del usuario |

> Estos endpoints los provee **Supabase directamente** — no necesitan implementación en Railway.

---

## 🟢 OPCIONAL — Mejora la experiencia

| Método | Endpoint | Descripción |
|--------|----------|-------------|
| `GET` | `/api/config` | Devuelve variables de configuración visibles (URLs, colas) para la sección Configuración |
| `GET` | `/api/transactions/:id` | Detalle completo de una transacción individual |
| `GET` | `/api/webhooks/:id` | Payload completo de un webhook específico |
| `POST` | `/api/webhooks/export` | Exportar webhooks filtrados a CSV/JSON |

---

## Resumen por Sección del Dashboard

| Sección | Endpoints necesarios | Prioridad |
|---------|---------------------|-----------|
| Overview (KPI cards) | `/api/overview`, `ws/dashboard/live` | 🔴 Crítico |
| Transacciones (tabla) | `/api/transactions`, `/api/transactions/summary` | 🔴 Crítico |
| Gráficas de área | `/api/transactions/hourly` | 🔴 Crítico |
| Webhooks (tabla + gráfica) | `/api/webhooks/recent`, `/api/webhooks/stats` | 🔴 Crítico |
| Webhooks en vivo | `ws/webhooks/live` | 🔴 Crítico |
| RabbitMQ / DLQ | `/api/rabbitmq/queues`, `/api/rabbitmq/dlq` | 🔴 Crítico |
| Servidores / Health | `/api/health`, `/api/health/latency` | 🟡 Importante |
| Railway | `/api/railway/deployments` | 🟡 Importante |
| Login | `/auth/v1/token` (Supabase) | 🟡 Importante |
| Configuración | `/api/config` | 🟢 Opcional |

---

## Stack de Implementación Sugerido

```
Backend Railway
├── Express + Node.js
├── Proxy → BNC ESolutions API v4.1 (https://servicios.bncenlinea.com:16500/api)
├── Proxy → RabbitMQ Management API (port 15672)
├── Socket.io o ws → WebSocket para /dashboard/live y /webhooks/live
└── Supabase Client → persistencia de webhooks e histórico de transacciones

Base de datos Supabase
├── tabla: webhooks (payload BNC Push V2, timestamp, tipo, status HTTP)
├── tabla: transactions (referencia BNC, monto, tipo, estado)
└── tabla: dlq_messages (mensajes fallidos con motivo)
```

---

*Generado el 2026-05-17 — BNC Payment Monitor v1.0*
