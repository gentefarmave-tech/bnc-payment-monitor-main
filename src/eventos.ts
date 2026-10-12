// ============================================================
// Traduccion de eventos de auditoria (GET /api/v1/audit) a lenguaje claro.
// Cada evento se explica con: que paso, por que, y que hacer.
// El detalle tecnico (payload original) queda aparte, solo para operadores.
// ============================================================

export interface WebhookAudit {
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

export type EventLevel = "ok" | "info" | "warn" | "error";

export interface EventExplanation {
  level: EventLevel;
  title: string;      // que paso (una linea)
  why?: string;       // por que paso
  action?: string;    // que hacer
  technical: string;  // detalle crudo para operadores
}

// Estados de auditoria que cierran el ciclo de una notificacion.
export const WEBHOOK_OK_STATUSES  = ["WEBHOOK_SUCCESS", "WORKER_SUCCESS"];
export const WEBHOOK_BAD_STATUSES = ["WEBHOOK_ERROR", "WEBHOOK_PUBLISH_FAILED", "WEBHOOK_UNPROCESSED"];

const FIELD_LABELS: Record<string, string> = {
  Hour: "la hora (Hour)",
  Date: "la fecha (Date)",
  Amount: "el monto (Amount)",
  CurrencyCode: "el codigo de moneda (CurrencyCode)",
  CommerceID: "el RIF del comercio (CommerceID)",
  CommercePhone: "el telefono del comercio (CommercePhone)",
  ClientPhone: "el telefono del cliente (ClientPhone)",
  OriginBankReference: "la referencia de origen (OriginBankReference)",
  DestinyBankReference: "la referencia de destino (DestinyBankReference)",
  OriginBankCode: "el codigo del banco de origen (OriginBankCode)",
};

/** Convierte "Hour debe ser formato militar HHMM (ej. 2359)" en una frase entendible. */
export function explainValidation(raw: string): string {
  const msg = raw.replace(/^Errores de validaci[oó]n:\s*/i, "").trim();
  const parts = msg.split(/;\s*|\n/).map(p => p.trim()).filter(Boolean);
  return parts.map(p => {
    const field = Object.keys(FIELD_LABELS).find(f => p.startsWith(f));
    if (field && /HHMM/i.test(p)) return `${cap(FIELD_LABELS[field])} debe venir en formato HHMM, por ejemplo 1430.`;
    if (field && /yyyyMMdd|AAAAMMDD/i.test(p)) return `${cap(FIELD_LABELS[field])} debe venir en formato AAAAMMDD, por ejemplo 20261009.`;
    if (field) return `En ${FIELD_LABELS[field]}: ${p.slice(field.length).trim()}.`;
    return p.endsWith(".") ? p : p + ".";
  }).join(" ");
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function jsonFrom(detail: string | null): Record<string, unknown> | null {
  if (!detail) return null;
  const i = detail.indexOf("{");
  if (i < 0) return null;
  try { return JSON.parse(detail.slice(i)); } catch { return null; }
}

export function describeAuditEvent(a: WebhookAudit): EventExplanation {
  const technical = a.detail ?? "";
  const payload = jsonFrom(a.detail);
  const amount = payload && (payload.Amount ?? payload.amount);
  const amountTxt = amount != null ? ` por Bs. ${Number(amount).toLocaleString("es-VE")}` : "";

  switch (a.status) {
    case "TRANSACTION_INITIATED":
      return { level: "info", title: `Pago iniciado${amountTxt}`,
        why: "El banco aceptó la solicitud de pago.",
        action: "Se espera la notificación de confirmación del banco.", technical };

    case "WEBHOOK_RECEIVED":
      return { level: "info", title: "Notificación del banco recibida",
        why: "Llegó y se autenticó correctamente.", technical };

    case "WEBHOOK_PROCESSING":
      return { level: "info", title: "Procesando la notificación del banco", technical };

    case "WEBHOOK_SUCCESS":
      return { level: "ok", title: `Pago confirmado por el banco${amountTxt}`, technical };

    case "WORKER_SUCCESS":
      return { level: "ok", title: "Pago conciliado en el sistema", technical };

    case "WEBHOOK_DUPLICATE":
      return { level: "info", title: "Notificación repetida (ignorada)",
        why: "El banco envió otra vez una notificación que ya se había procesado.",
        action: "No hay nada que hacer: el pago no se duplicó.", technical };

    case "WEBHOOK_ERROR": {
      const isValidation = /validaci[oó]n/i.test(technical);
      return {
        level: "error",
        title: "La notificación del banco fue rechazada",
        why: isValidation ? explainValidation(technical) : (technical || "Error al procesar la notificación."),
        action: "El pago NO se marcó como fallido: sigue en espera. Pide al banco que reenvíe la notificación con el dato corregido, o confirma el estado de la operación con el código de autorización.",
        technical,
      };
    }

    case "WEBHOOK_PUBLISH_FAILED":
    case "WEBHOOK_UNPROCESSED":
      return { level: "error", title: "No se pudo registrar la confirmación del pago",
        why: "La notificación llegó bien, pero falló el paso interno que la procesa.",
        action: "La notificación quedó respaldada. Contacta a soporte para reprocesarla; no reenvíes el pago.", technical };

    case "ERROR": {
      const m = technical.match(/Transaction not found for reference:\s*(\S+)/i);
      if (m) {
        return { level: "warn", title: `Confirmación para una referencia desconocida (${m[1]})`,
          why: "Llegó una confirmación del banco para una referencia que no existe en el sistema (o que aún no se había registrado).",
          action: "Verifica que la referencia sea la correcta. Si es un pago real, contacta a soporte.", technical };
      }
      return { level: "error", title: "Error interno al procesar un evento",
        action: "Contacta a soporte indicando la hora del evento.", technical };
    }

    default:
      return { level: "info", title: a.status.replace(/_/g, " ").toLowerCase(), technical };
  }
}
