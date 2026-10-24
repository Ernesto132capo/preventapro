import fs from "fs";
import path from "path";

// Generación, descargas y limpieza comparten la misma exclusión por carpeta.
// La reserva se hace antes de cualquier await para que GC no pueda comprobar
// una carpeta libre y borrarla justo cuando otra petición empieza a utilizarla.
const directoryLocks = new Map<string, Promise<void>>();

export async function withReportDirectoryLock<T>(
  directoryPath: string,
  operation: () => Promise<T>
): Promise<T> {
  const lockKey = path.resolve(directoryPath);
  const previous = directoryLocks.get(lockKey) || Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  directoryLocks.set(lockKey, current);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (directoryLocks.get(lockKey) === current) directoryLocks.delete(lockKey);
  }
}

export function isMissingReportPath(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/** I/O asíncrono; vuelve a comprobar la antigüedad dentro del lock de la carpeta. */
export async function removeExpiredReportDirectories(
  reportsRoot: string,
  ttlMs: number,
  now = Date.now()
): Promise<void> {
  try {
    const entries = await fs.promises.readdir(reportsRoot, { withFileTypes: true });
    await Promise.all(entries.map(async (entry) => {
      if (!entry.isDirectory()) return;
      const directoryPath = path.join(reportsRoot, entry.name);
      await withReportDirectoryLock(directoryPath, async () => {
        try {
          const stats = await fs.promises.stat(directoryPath);
          if (now - stats.mtimeMs > ttlMs) {
            await fs.promises.rm(directoryPath, { recursive: true, force: true });
          }
        } catch (error) {
          if (!isMissingReportPath(error)) {
            console.warn(`No se pudo limpiar la carpeta de reportes ${entry.name}:`, error);
          }
        }
      });
    }));
  } catch (error) {
    if (!isMissingReportPath(error)) {
      console.warn("No se pudieron revisar los reportes vencidos:", error);
    }
  }
}
