import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { removeExpiredReportDirectories, withReportDirectoryLock } from "../services/report-storage";

const hour = 60 * 60 * 1000;
const ttl = 24 * hour;
let root: string;

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function expiredDirectory(name: string): Promise<string> {
  const directory = path.join(root, name);
  await fs.promises.mkdir(directory, { recursive: true });
  await fs.promises.writeFile(path.join(directory, "boletas_clientes.pdf"), "old report");
  const expired = new Date(Date.now() - ttl - hour);
  await fs.promises.utimes(directory, expired, expired);
  return directory;
}

beforeEach(async () => { root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "preventapro-report-storage-")); });
afterEach(async () => { await fs.promises.rm(root, { recursive: true, force: true }); });

describe("Reportes: exclusión entre generación, descargas y GC", () => {
  it("espera una generación en vuelo y revisa la antigüedad de nuevo antes de borrar", async () => {
    const directory = await expiredDirectory("generating");
    const started = gate();
    const finishGeneration = gate();
    const generating = withReportDirectoryLock(directory, async () => {
      started.resolve();
      await finishGeneration.promise;
      await fs.promises.writeFile(path.join(directory, "lista_de_productos.xlsx"), "fresh report");
    });
    await started.promise;
    let cleaned = false;
    const cleanup = removeExpiredReportDirectories(root, ttl).then(() => { cleaned = true; });
    // Otra carpeta y el Event Loop siguen disponibles mientras GC espera el lock.
    await withReportDirectoryLock(path.join(root, "other"), async () => {});
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(cleaned).toBe(false);
    expect(fs.existsSync(directory)).toBe(true);
    finishGeneration.resolve();
    await Promise.all([generating, cleanup]);
    expect(await fs.promises.readFile(path.join(directory, "lista_de_productos.xlsx"), "utf8")).toBe("fresh report");
  });

  it("mantiene el archivo hasta terminar la descarga y después puede limpiar su carpeta vencida", async () => {
    const directory = await expiredDirectory("downloading");
    const started = gate();
    const finishDownload = gate();
    const downloading = withReportDirectoryLock(directory, async () => {
      started.resolve();
      await finishDownload.promise;
      expect(await fs.promises.readFile(path.join(directory, "boletas_clientes.pdf"), "utf8")).toBe("old report");
    });
    await started.promise;
    const cleanup = removeExpiredReportDirectories(root, ttl);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(fs.existsSync(directory)).toBe(true);
    finishDownload.resolve();
    await Promise.all([downloading, cleanup]);
    expect(fs.existsSync(directory)).toBe(false);
  });

  it("limpia solo carpetas vencidas y acepta una instalación sin directorio raíz", async () => {
    await expiredDirectory("expired");
    const fresh = path.join(root, "fresh");
    await fs.promises.mkdir(fresh);
    await fs.promises.writeFile(path.join(root, ".gitkeep"), "");
    await removeExpiredReportDirectories(root, ttl);
    expect(fs.existsSync(path.join(root, "expired"))).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
    expect(fs.existsSync(path.join(root, ".gitkeep"))).toBe(true);
    await expect(removeExpiredReportDirectories(path.join(root, "missing"), ttl)).resolves.toBeUndefined();
  });

  it("libera la carpeta tras un error y serializa el siguiente trabajo sobre la misma ruta", async () => {
    const directory = path.join(root, "failed");
    const firstStarted = gate();
    const finishFirst = gate();
    const first = withReportDirectoryLock(directory, async () => {
      firstStarted.resolve();
      await finishFirst.promise;
      throw new Error("SQL interrumpido");
    });
    await firstStarted.promise;
    let secondStarted = false;
    const second = withReportDirectoryLock(directory, async () => {
      secondStarted = true;
      await fs.promises.mkdir(directory, { recursive: true });
      await fs.promises.writeFile(path.join(directory, "report"), "retry");
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(secondStarted).toBe(false);
    const failed = expect(first).rejects.toThrow("SQL interrumpido");
    finishFirst.resolve();
    await failed;
    await second;
    expect(secondStarted).toBe(true);
    expect(await fs.promises.readFile(path.join(directory, "report"), "utf8")).toBe("retry");
  });
});
