/**
 * Utilidades para formateo de fechas consistente con la zona horaria de Bolivia (America/La_Paz).
 * Evita desfases de día causados por la interpretación de 'YYYY-MM-DD' como UTC medianoche por Date().
 */

/**
 * Formatea una fecha o timestamp a formato local 'DD/MM/AAAA' en America/La_Paz.
 */
export function formatBoliviaDate(value: string | Date | null | undefined): string {
  if (!value) return "";
  if (typeof value === "string") {
    const trimmed = value.trim();
    // Si viene solo como "YYYY-MM-DD" (ej. work_date), extraer directamente sin restar horas
    const dateOnlyMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
    if (dateOnlyMatch) {
      const [, y, m, d] = dateOnlyMatch;
      return `${d}/${m}/${y}`;
    }
  }
  const date = typeof value === "string" ? new Date(value) : value;
  if (isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("es-BO", {
    timeZone: "America/La_Paz",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(date);
}

/**
 * Formatea fecha y hora local de Bolivia 'DD/MM/AAAA, HH:mm'.
 */
export function formatBoliviaDateTime(value: string | Date | null | undefined): string {
  if (!value) return "";
  if (typeof value === "string") {
    const trimmed = value.trim();
    const dateOnlyMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
    if (dateOnlyMatch) {
      const [, y, m, d] = dateOnlyMatch;
      return `${d}/${m}/${y}`;
    }
  }
  const date = typeof value === "string" ? new Date(value) : value;
  if (isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("es-BO", {
    timeZone: "America/La_Paz",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

/**
 * Obtiene la fecha actual en formato 'YYYY-MM-DD' en la zona horaria de Bolivia (America/La_Paz).
 */
export function getBoliviaToday(): string {
  return getBoliviaDate(new Date());
}

/** Fecha calendario de un instante en Bolivia, también para capturas offline. */
export function getBoliviaDate(value: Date | string): string {
  const date = typeof value === "string" ? new Date(value) : value;
  if (!Number.isFinite(date.getTime())) throw new Error("Fecha no válida.");
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/La_Paz",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const v = (t: string) => p.find((x) => x.type === t)?.value;
  return `${v("year")}-${v("month")}-${v("day")}`;
}
