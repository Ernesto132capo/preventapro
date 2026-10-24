import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import vm from "vm";
import ts from "typescript";
import * as storage from "../services/report-storage";

const hour = 60 * 60 * 1000;
let tempDir: string;
let clock: number;
type Generator = (id: string, directory: string) => Promise<string>;

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(async () => {
  tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "preventapro-report-route-"));
  clock = Date.now();
});
afterEach(async () => { await fs.promises.rm(tempDir, { recursive: true, force: true }); });

/** Ejecuta la ruta real con filesystem real y generadores controlables, sin abrir un puerto. */
async function loadRoute(generator: Generator) {
  let getHandler: any;
  const router = { post: vi.fn(), get: (_url: string, _auth: unknown, handler: unknown) => { getHandler = handler; } };
  const filename = path.resolve(__dirname, "../routes/reports.ts");
  const compiled = ts.transpileModule(await fs.promises.readFile(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
  const moduleObject = { exports: {} as { cleanupExpiredReportDirectories: () => Promise<void> } };
  class ReportDate extends Date { static now() { return clock; } }
  vm.runInNewContext(compiled, {
    module: moduleObject, exports: moduleObject.exports,
    __dirname: path.join(tempDir, "src", "routes"), Date: ReportDate, console,
    require(name: string) {
      if (name === "express") return { Router: () => router };
      if (name === "path") return path;
      if (name === "fs") return fs;
      if (name === "../db/pg") return { pool: { query: async () => ({ rows: [{ id: "exists" }] }) } };
      if (name === "../middleware/auth") return { requireAuth: vi.fn(), requireReportDownloadAuth: vi.fn() };
      if (name === "../services/auth") return { createReportDownloadToken: () => "test-token" };
      if (name === "../services/excel") return { generateProductListExcel: generator };
      if (name === "../services/receipts-pdf") return {};
      if (name === "../services/report-storage") return storage;
      throw new Error(`Import inesperado: ${name}`);
    },
  });
  await moduleObject.exports.cleanupExpiredReportDirectories();

  function request(id: string, finishDownload = Promise.resolve(), downloadError?: NodeJS.ErrnoException) {
    const downloadStarted = gate();
    let status = 200;
    let result: { status: number; body?: any } | undefined;
    const res = {
      headersSent: false,
      status(code: number) { status = code; return this; },
      json(body: unknown) { result = { status, body }; return this; },
      download(_file: string, _name: string, callback: (error?: NodeJS.ErrnoException) => void) {
        downloadStarted.resolve();
        void finishDownload.then(() => { result = { status }; callback(downloadError); });
      },
    };
    const response = getHandler({ params: { workDayId: id, fileName: "lista_de_productos.xlsx" } }, res,
      (error?: unknown) => { if (error) throw error; }
    ).then(() => result);
    return { response: response as Promise<{ status: number; body?: any }>, downloadStarted: downloadStarted.promise };
  }
  return { request, cleanup: moduleObject.exports.cleanupExpiredReportDirectories, root: path.join(tempDir, "reports") };
}

async function writeReport(_id: string, directory: string) {
  const file = path.join(directory, "lista_de_productos.xlsx");
  await fs.promises.writeFile(file, "test report");
  return file;
}

describe("Ruta de reportes: protección durante toda la respuesta", () => {
  it("GC de otra petición no borra una carpeta mientras su generador está esperando datos", async () => {
    const origin = clock;
    const oldDir = path.join(tempDir, "reports", "old");
    await fs.promises.mkdir(oldDir, { recursive: true });
    const oldTime = new Date(origin - 23.5 * hour);
    await fs.promises.utimes(oldDir, oldTime, oldTime);
    const started = gate();
    const finishGeneration = gate();
    const route = await loadRoute(async (id, directory) => {
      if (id === "old") { started.resolve(); await finishGeneration.promise; }
      return writeReport(id, directory);
    });
    clock = origin + hour - 1;
    const first = route.request("old");
    await started.promise;
    clock = origin + hour + 1;
    const second = await route.request("new").response;
    expect(second.status).toBe(200);
    expect(fs.existsSync(oldDir)).toBe(true);
    finishGeneration.resolve();
    expect((await first.response).status).toBe(200);
    await route.cleanup();
    expect(await fs.promises.readFile(path.join(oldDir, "lista_de_productos.xlsx"), "utf8")).toBe("test report");
  });

  it("mantiene la reserva hasta el callback de descarga y deja continuar otras jornadas", async () => {
    const route = await loadRoute(writeReport);
    const finishDownload = gate();
    const first = route.request("downloading", finishDownload.promise);
    await first.downloadStarted;
    const directory = path.join(route.root, "downloading");
    const expired = new Date(Date.now() - 25 * hour);
    await fs.promises.utimes(directory, expired, expired);
    clock += hour + 1;
    expect((await route.request("other").response).status).toBe(200);
    expect(fs.existsSync(directory)).toBe(true);
    finishDownload.resolve();
    expect((await first.response).status).toBe(200);
    await route.cleanup();
    expect(fs.existsSync(directory)).toBe(false);
  });

  it("responde 404 claro si el generador no dejó el archivo y libera la carpeta", async () => {
    let missing = true;
    const route = await loadRoute(async (id, directory) => missing
      ? path.join(directory, "lista_de_productos.xlsx")
      : writeReport(id, directory));
    const first = await route.request("missing").response;
    expect(first.status).toBe(404);
    expect(first.body.error).toContain("no está disponible");
    missing = false;
    expect((await route.request("missing").response).status).toBe(200);
  });

  it("maneja ENOENT en la descarga y permite volver a solicitar la misma jornada", async () => {
    const route = await loadRoute(writeReport);
    const missing = Object.assign(new Error("Archivo eliminado externamente"), { code: "ENOENT" });
    expect((await route.request("removed", Promise.resolve(), missing).response).status).toBe(404);
    expect((await route.request("removed").response).status).toBe(200);
  });
});
