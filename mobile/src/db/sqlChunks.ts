import type { SQLiteDatabase } from "expo-sqlite";

// SQLite de Android < 11 (3.22) limita las variables por consulta a 999.
// Se usa un margen por si la consulta tiene otros parámetros además de los ids.
const CHUNK_SIZE = 800;

/**
 * Divide `ids` en bloques y ejecuta `run(chunk)` por bloque, concatenando los
 * resultados. Evita superar el límite de variables de SQLite en consultas con
 * cláusulas `IN (...)` sobre listas grandes (catálogo, consolidados de jornada).
 */
export async function forEachIdChunk<T>(
  ids: string[],
  run: (chunk: string[]) => Promise<T[]>
): Promise<T[]> {
  if (ids.length === 0) return [];
  const results: T[] = [];
  for (let start = 0; start < ids.length; start += CHUNK_SIZE) {
    const chunk = ids.slice(start, start + CHUNK_SIZE);
    results.push(...(await run(chunk)));
  }
  return results;
}

/** Genera los placeholders `?,?,...` para una lista de ids. */
export function placeholdersFor(ids: string[]): string {
  return ids.map(() => "?").join(",");
}

// Re-export del tipo para que los repositorios no tengan que importar expo-sqlite solo por el tipo.
export type { SQLiteDatabase };
