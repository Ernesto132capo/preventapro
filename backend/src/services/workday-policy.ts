import { getBoliviaDate } from "./dates";

/** La misma excepción offline rige en /orders y /sync/push. Nunca permite editar una jornada cerrada. */
export function isLegitimateOfflineOrder(
  workDay: { work_date: string; closed_at?: string | Date | null },
  capturedAt: unknown
): boolean {
  if (typeof capturedAt !== "string" || !capturedAt.trim()) return false;
  const captured = new Date(capturedAt);
  if (!Number.isFinite(captured.getTime())) return false;
  const closed = workDay.closed_at ? new Date(workDay.closed_at).getTime() : NaN;
  // Las jornadas antiguas pueden no conservar la hora de cierre. En ese caso
  // solo se recuperan capturas de su mismo día calendario en Bolivia.
  if (!Number.isFinite(closed)) return getBoliviaDate(captured) === workDay.work_date;
  // Tolerancia para un pequeño desfase entre el reloj del teléfono y el servidor.
  // Compartir el día no autoriza una nueva venta posterior al cierre.
  return captured.getTime() <= closed + 15 * 60 * 1000;
}
