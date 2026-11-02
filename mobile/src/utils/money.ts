/**
 * Convierte un monto en Bolivianos a centavos enteros de forma exacta.
 * Acepta punto o coma como separador decimal (máx. 2 decimales) y devuelve
 * `NaN` ante entradas ambiguas o inválidas para que el llamador las rechace.
 */
export function parseBsToCents(text: string): number {
  const trimmed = (text ?? "").trim();
  if (trimmed === "") return 0;
  // Más de un separador decimal (p. ej. "1.2.3" o "1,2,3") es ambiguo.
  if (/[.,].*[.,]/.test(trimmed)) return NaN;
  const normalized = trimmed.replace(",", ".");
  // Entero positivo con hasta 2 decimales (permite "5." y "5.5", no ".5").
  if (!/^\d+(\.\d{0,2})?$/.test(normalized)) return NaN;
  const [whole, fraction = ""] = normalized.split(".");
  const cents = Number(whole) * 100 + Number((fraction + "00").slice(0, 2));
  if (!Number.isSafeInteger(cents) || cents < 0) return NaN;
  return cents;
}
