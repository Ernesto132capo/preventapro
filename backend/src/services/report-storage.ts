import fs from "fs";
import path from "path";

// Las descargas comparten una reserva de lectura. Limpieza y eliminación
// esperan todas las reservas anteriores; lectores nuevos respetan esa espera.
interface DirectoryAccess { barrier: Promise<void>; readers: Set<Promise<void>>; reservations: number }
const directoryLocks = new Map<string, DirectoryAccess>();

async function reserveDirectory<T>(directoryPath: string, shared: boolean, operation: () => Promise<T>): Promise<T> {
  const key = path.resolve(directoryPath);
  let access = directoryLocks.get(key);
  if (!access) {
    access = { barrier: Promise.resolve(), readers: new Set(), reservations: 0 };
    directoryLocks.set(key, access);
  }
  const previous = shared ? access.barrier : Promise.all([access.barrier, ...access.readers]);
  let release!: () => void;
  const reservation = new Promise<void>(resolve => { release = resolve; });
  access.reservations++;
  if (shared) access.readers.add(reservation);
  else access.barrier = reservation;
  await previous;
  try { return await operation(); }
  finally {
    access.readers.delete(reservation);
    release();
    if (--access.reservations === 0 && directoryLocks.get(key) === access) directoryLocks.delete(key);
  }
}

export function withReportDirectoryRead<T>(directoryPath: string, operation: () => Promise<T>): Promise<T> {
  return reserveDirectory(directoryPath, true, operation);
}

export async function withReportDirectoryLock<T>(
  directoryPath: string,
  operation: () => Promise<T>
): Promise<T> {
  return reserveDirectory(directoryPath, false, operation);
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
