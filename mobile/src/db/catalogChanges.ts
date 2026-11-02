/** Sólo compara datos que afectan al catálogo; los ACK y timestamps no son cambios de contenido. */
export function catalogRowChanged(previous: Record<string, any> | null | undefined, next: Record<string, any>): boolean {
  if (!previous) return true;
  return Object.entries(next).some(([column, value]) => {
    const before = previous[column] ?? null;
    if (typeof value === "number") return before === null || Number(before) !== value;
    return before !== (value ?? null);
  });
}
