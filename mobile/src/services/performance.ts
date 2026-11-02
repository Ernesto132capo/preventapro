/** Mediciones locales agregadas. No conserva registros, mensajes de error ni datos de usuarios. */
const OPERATIONS = [
  "sale.catalog_validation", "sale.local_save", "db.open", "db.transaction_wait", "db.transaction",
  "sync.queue_wait", "sync.full", "sync.push", "sync.pull", "sync.outbox",
] as const;

export type PerformanceOperation = typeof OPERATIONS[number];

export interface PerformanceMetric {
  name: PerformanceOperation;
  count: number;
  failures: number;
  lastMs: number;
  maxMs: number;
  totalMs: number;
  lastRecordedAt: string;
}

const metrics = new Map<PerformanceOperation, PerformanceMetric>();
let generation = 0;

function nowMs(): number {
  try {
    return typeof performance !== "undefined" && typeof performance.now === "function"
      ? performance.now() : Date.now();
  } catch {
    // Un reloj de diagnóstico no debe impedir guardar o liberar una transacción.
    return Number.NaN;
  }
}

/** El cierre es idempotente y no registra mediciones anteriores a un reinicio. */
export function beginPerformanceMeasure(name: PerformanceOperation): (success?: boolean) => void {
  const startedAt = nowMs();
  const startedGeneration = generation;
  let finished = false;
  return (success = true) => {
    if (finished) return;
    finished = true;
    if (generation !== startedGeneration || !(OPERATIONS as readonly string[]).includes(name)) return;
    const elapsed = nowMs() - startedAt;
    if (!Number.isFinite(elapsed)) return;
    const duration = Math.max(0, elapsed);
    const previous = metrics.get(name);
    metrics.set(name, {
      name,
      count: (previous?.count ?? 0) + 1,
      failures: (previous?.failures ?? 0) + (success ? 0 : 1),
      lastMs: duration,
      maxMs: Math.max(previous?.maxMs ?? 0, duration),
      totalMs: (previous?.totalMs ?? 0) + duration,
      lastRecordedAt: new Date().toISOString(),
    });
  };
}

/** Mide una tarea manteniendo su valor de retorno y el objeto de error original. */
export async function measurePerformance<T>(
  name: PerformanceOperation,
  task: () => Promise<T>,
  isSuccess: (result: T) => boolean = () => true
): Promise<T> {
  const finish = beginPerformanceMeasure(name);
  try {
    const result = await task();
    let successful = true;
    try { successful = isSuccess(result); } catch { /* El diagnóstico no altera el resultado de negocio. */ }
    finish(successful);
    return result;
  } catch (error) {
    finish(false);
    throw error;
  }
}

export function getPerformanceMetrics(): PerformanceMetric[] {
  return OPERATIONS.flatMap(name => {
    const metric = metrics.get(name);
    return metric ? [{ ...metric }] : [];
  });
}

/** Solo borra contadores de esta sesión; no consulta ni modifica SQLite. */
export function resetPerformanceMetrics(): void {
  generation++;
  metrics.clear();
}
