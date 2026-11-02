import fs from "fs";
import path from "path";
import vm from "vm";
import ts from "typescript";

/**
 * Ejecuta las funciones públicas del Provider real con promesas controladas.
 * El harness omite efectos y render; estos casos verifican exclusivamente la
 * coordinación de tareas y el orden de las operaciones, no el ciclo de React.
 * Los respaldos y sus transacciones SQLite se prueban en local_backup_outbox.
 */
interface ProviderActions {
  forceSync(options?: { fullRecovery?: boolean }): Promise<void>;
  pushSync(): Promise<void>;
  backupLocalData(): Promise<unknown>;
  restoreLocalData(uri: string): Promise<void>;
  resetLocalData(): Promise<unknown>;
  discardFailedItems(): Promise<void>;
  refreshPending(): Promise<OutboxSummary>;
}

interface OutboxSummary {
  total: number;
  pending: number;
  syncing: number;
  failed: number;
  error: number;
  conflict: number;
}

const okResult = { ok: true, pushed: { done: 1, deferred: 0, failed: 0 } };
const backupInfo = { uri: "file:///app/preventapro-backups/preventapro-test.json", createdAt: "2026-10-20T12:00:00.000Z", orderCount: 1, pendingCount: 1 };
const sourcePath = path.join(__dirname, "../context/SyncContext.tsx");
const compiledProvider = ts.transpileModule(fs.readFileSync(sourcePath, "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, esModuleInterop: true },
  fileName: sourcePath,
}).outputText;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function mountProvider(options: { connected?: boolean } = {}) {
  const services = {
    runSync: jest.fn(async (..._args: any[]) => okResult),
    pushOnlySync: jest.fn(async (..._args: any[]) => okResult),
    withSyncMaintenance: jest.fn(async (operation: () => Promise<unknown>) => operation()),
    resetSyncCooldown: jest.fn(),
  };
  const db = { resetLocalDatabase: jest.fn(async (..._args: any[]) => {}) };
  const outbox = {
    getOutboxSummary: jest.fn(async (): Promise<OutboxSummary> => ({ total: 1, pending: 1, syncing: 0, failed: 0, error: 0, conflict: 0 })),
    discardFailed: jest.fn(async () => 1), purgeCompletedOutbox: jest.fn(async () => 0),
  };
  const backups = {
    createLocalBackup: jest.fn(async (..._args: any[]) => backupInfo),
    restoreLocalBackup: jest.fn(async (..._args: any[]) => backupInfo),
  };
  const setters: jest.Mock[] = [];
  const react = {
    createContext: () => ({ Provider: "SyncContext.Provider" }),
    createElement: (type: unknown, props: any) => ({ type, props }),
    useContext: jest.fn(),
    useEffect: jest.fn(), // No iniciar listeners ni temporizadores en este harness.
    useRef: (value: unknown) => ({ current: value }),
    useState: (value: unknown) => {
      const setter = jest.fn();
      const index = setters.push(setter) - 1;
      return [index === 0 ? options.connected ?? value : value, setter];
    },
    useCallback: (callback: unknown) => callback,
  };
  const dependencies: Record<string, unknown> = {
    react,
    "react-native": { AppState: { addEventListener: jest.fn() } },
    "@react-native-community/netinfo": { addEventListener: jest.fn() },
    "../services/sync": services,
    "../db/outbox": outbox,
    "../db/client": db,
    "../services/localBackup": backups,
    "./AuthContext": { useAuth: () => ({ user: { id: "user-1" } }) },
  };
  const module = { exports: {} as { SyncProvider?: (props: { children: null }) => { props: { value: ProviderActions } } } };
  vm.runInNewContext(compiledProvider, {
    module, exports: module.exports,
    require: (name: string) => {
      if (!(name in dependencies)) throw new Error(`Dependencia inesperada del Provider: ${name}`);
      return dependencies[name];
    },
    console, setInterval: jest.fn(), clearInterval: jest.fn(),
  }, { filename: sourcePath });
  const value = module.exports.SyncProvider!({ children: null }).props.value;
  const [isConnected, connection, pendingCount, failedCount, correctionCount, lastSyncedAt, lastError, syncTick, catalogRevision, pullRevision] = setters;
  return { value, services, db, outbox, backups, state: { isConnected, connection, pendingCount, failedCount, correctionCount, lastSyncedAt, lastError, syncTick, catalogRevision, pullRevision } };
}

describe("Coordinación de acciones públicas de SyncContext", () => {
  it("informa el total real de errores aunque existan más de cinco operaciones fallidas", async () => {
    const { value, outbox, state } = mountProvider();
    outbox.getOutboxSummary.mockResolvedValue({ total: 13, pending: 2, syncing: 1, failed: 3, error: 7, conflict: 0 });

    await value.pushSync();

    expect(state.pendingCount).toHaveBeenLastCalledWith(13);
    expect(state.failedCount).toHaveBeenLastCalledWith(10);
    expect(state.correctionCount).toHaveBeenLastCalledWith(7);
    expect(state.lastError).toHaveBeenLastCalledWith(expect.stringContaining("10"));
    expect(state.lastSyncedAt).not.toHaveBeenCalled();
  });

  it("conserva visibles los errores permanentes al refrescar pendientes sin conexión", async () => {
    const { value, services, outbox, state } = mountProvider({ connected: false });
    outbox.getOutboxSummary.mockResolvedValue({ total: 9, pending: 0, syncing: 0, failed: 0, error: 9, conflict: 0 });

    await value.pushSync();

    expect(services.runSync).not.toHaveBeenCalled();
    expect(services.pushOnlySync).not.toHaveBeenCalled();
    expect(state.pendingCount).toHaveBeenLastCalledWith(9);
    expect(state.failedCount).toHaveBeenLastCalledWith(9);
    expect(state.correctionCount).toHaveBeenLastCalledWith(9);
  });

  it("permite refrescar el resumen local sin iniciar tráfico de sincronización", async () => {
    const { value, services, outbox, state } = mountProvider();
    const summary = { total: 4, pending: 2, syncing: 0, failed: 1, error: 1, conflict: 0 };
    outbox.getOutboxSummary.mockResolvedValue(summary);

    await expect(value.refreshPending()).resolves.toEqual(summary);

    expect(state.pendingCount).toHaveBeenLastCalledWith(4);
    expect(state.failedCount).toHaveBeenLastCalledWith(2);
    expect(state.correctionCount).toHaveBeenLastCalledWith(1);
    expect(services.runSync).not.toHaveBeenCalled();
    expect(services.pushOnlySync).not.toHaveBeenCalled();
  });

  it("forceSync espera un push activo antes de refrescar incrementalmente", async () => {
    const { value, services } = mountProvider();
    const pushing = deferred<typeof okResult>();
    services.pushOnlySync.mockImplementationOnce(() => pushing.promise);
    const push = value.pushSync();
    const full = value.forceSync();
    expect(services.pushOnlySync).toHaveBeenCalledTimes(1);
    expect(services.runSync).not.toHaveBeenCalled();
    pushing.resolve(okResult);
    await Promise.all([push, full]);
    expect(services.runSync).toHaveBeenCalledTimes(1);
    expect(services.runSync).toHaveBeenCalledWith("user-1", { forcePull: false, refresh: true });
  });

  it("reserva la descarga completa para la recuperación explícita", async () => {
    const { value, services } = mountProvider();
    await value.forceSync({ fullRecovery: true });
    expect(services.runSync).toHaveBeenCalledWith("user-1", { forcePull: true });
  });

  it("no invalida el catálogo sin cambios y refleja un envío aunque falle el pull", async () => {
    const { value, services, state } = mountProvider();
    services.runSync.mockResolvedValueOnce({ ...okResult, didPull: true, catalogChanged: false } as any);
    await value.forceSync();
    expect(state.catalogRevision).not.toHaveBeenCalled();
    expect(state.pullRevision).toHaveBeenCalledTimes(1);
    services.runSync.mockResolvedValueOnce({ ...okResult, ok: false, error: "Falló el catálogo", catalogChanged: true } as any);
    await value.forceSync();
    expect(state.catalogRevision).toHaveBeenCalledTimes(1);
    expect(state.syncTick).toHaveBeenCalledTimes(2);
    expect(state.lastError).toHaveBeenLastCalledWith("Falló el catálogo");
  });

  it("dos disparos de push no se solapan y el segundo se atiende después del primero", async () => {
    const { value, services } = mountProvider();
    const gate = deferred<void>();
    let active = 0;
    let maximum = 0;
    services.pushOnlySync.mockImplementationOnce(async () => {
      active++;
      maximum = Math.max(maximum, active);
      await gate.promise;
      active--;
      return okResult;
    }).mockImplementationOnce(async () => {
      active++;
      maximum = Math.max(maximum, active);
      active--;
      return okResult;
    });
    const first = value.pushSync();
    const second = value.pushSync();
    expect(services.pushOnlySync).toHaveBeenCalledTimes(1);
    gate.resolve();
    await Promise.all([first, second]);
    expect(services.pushOnlySync).toHaveBeenCalledTimes(2);
    expect(maximum).toBe(1);
    expect(services.runSync).not.toHaveBeenCalled();
  });

  it("un push posterior no oculta un fallo pendiente del pull y una descarga exitosa lo limpia", async () => {
    const { value, services, state } = mountProvider();
    services.runSync.mockResolvedValueOnce({ ...okResult, ok: false, error: "Catálogo caído", pullError: "Catálogo caído" } as any);
    await value.forceSync();
    await value.pushSync();
    expect(state.lastError).toHaveBeenLastCalledWith(expect.stringContaining("Catálogo caído"));
    expect(state.lastSyncedAt).not.toHaveBeenCalled();
    services.runSync.mockResolvedValueOnce({ ...okResult, didPull: true, catalogChanged: false } as any);
    await value.forceSync();
    expect(state.lastError).toHaveBeenLastCalledWith(null);
    expect(state.lastSyncedAt).toHaveBeenCalledTimes(1);
  });

  it("un mantenimiento fallido no bloquea el siguiente mantenimiento ni una sincronización", async () => {
    const { value, services, backups } = mountProvider();
    const firstBackup = deferred<typeof backupInfo>();
    backups.createLocalBackup.mockImplementationOnce(() => firstBackup.promise);
    const first = value.backupLocalData();
    const rejected = expect(first).rejects.toThrow("Disco lleno");
    const second = value.backupLocalData();
    expect(backups.createLocalBackup).toHaveBeenCalledTimes(1);
    firstBackup.reject(new Error("Disco lleno"));
    await rejected;
    await expect(second).resolves.toEqual(backupInfo);
    expect(backups.createLocalBackup).toHaveBeenCalledTimes(2);
    await value.pushSync();
    expect(services.pushOnlySync).toHaveBeenCalledTimes(1);
  });

  it("atiende un push solicitado durante el respaldo al liberar el mantenimiento", async () => {
    const { value, services, backups } = mountProvider();
    const backupGate = deferred<typeof backupInfo>();
    const pushGate = deferred<typeof okResult>();
    backups.createLocalBackup.mockImplementationOnce(() => backupGate.promise);
    services.pushOnlySync.mockImplementationOnce(() => pushGate.promise);
    const backup = value.backupLocalData();
    const push = value.pushSync();
    const full = value.forceSync();
    expect(services.pushOnlySync).not.toHaveBeenCalled();
    backupGate.resolve(backupInfo);
    await Promise.all([backup, push]);
    expect(services.pushOnlySync).toHaveBeenCalledTimes(1);
    expect(services.runSync).not.toHaveBeenCalled();
    pushGate.resolve(okResult);
    await full;
    expect(services.runSync).toHaveBeenCalledTimes(1);
  });

  it("resetLocalData no borra SQLite ni fuerza sync si falla el respaldo", async () => {
    const { value, services, db, backups } = mountProvider();
    backups.createLocalBackup.mockRejectedValueOnce(new Error("No se pudo verificar el respaldo"));
    await expect(value.resetLocalData()).rejects.toThrow("No se pudo verificar el respaldo");
    expect(db.resetLocalDatabase).not.toHaveBeenCalled();
    expect(services.resetSyncCooldown).not.toHaveBeenCalled();
    expect(services.runSync).not.toHaveBeenCalled();
    await value.pushSync();
    expect(services.pushOnlySync).toHaveBeenCalledTimes(1);
  });

  it("resetLocalData espera el respaldo verificado y borra usando su misma transacción antes del pull", async () => {
    const { value, services, db, backups } = mountProvider();
    const verified = deferred<void>();
    const txDb = { transaction: "backup-and-reset" };
    const events: string[] = [];
    backups.createLocalBackup.mockImplementationOnce(async (afterSave) => {
      events.push("backup-start");
      await verified.promise;
      events.push("backup-verified");
      await afterSave(txDb);
      events.push("backup-finished");
      return backupInfo;
    });
    db.resetLocalDatabase.mockImplementationOnce(async () => { events.push("reset"); });
    services.runSync.mockImplementationOnce(async () => { events.push("full-sync"); return okResult; });
    const reset = value.resetLocalData();
    expect(db.resetLocalDatabase).not.toHaveBeenCalled();
    expect(services.runSync).not.toHaveBeenCalled();
    verified.resolve();
    await expect(reset).resolves.toEqual(backupInfo);
    expect(db.resetLocalDatabase).toHaveBeenCalledWith(txDb);
    expect(events).toEqual(["backup-start", "backup-verified", "reset", "backup-finished", "full-sync"]);
    expect(services.runSync).toHaveBeenCalledWith("user-1", { forcePull: true });
  });

  it("restaurar protege el estado actual con backup y pasa la misma conexión al restore", async () => {
    const { value, services, backups } = mountProvider();
    const txDb = { transaction: "backup-and-restore" };
    const events: string[] = [];
    backups.createLocalBackup.mockImplementationOnce(async (afterSave) => {
      events.push("backup-verified");
      await afterSave(txDb);
      events.push("backup-finished");
      return backupInfo;
    });
    backups.restoreLocalBackup.mockImplementationOnce(async () => { events.push("restore"); return backupInfo; });
    await value.restoreLocalData(backupInfo.uri);
    expect(backups.createLocalBackup).toHaveBeenCalledWith(expect.any(Function));
    expect(backups.restoreLocalBackup).toHaveBeenCalledWith(backupInfo.uri, txDb);
    expect(events).toEqual(["backup-verified", "restore", "backup-finished"]);
    expect(services.resetSyncCooldown).toHaveBeenCalledTimes(1);
    expect(services.runSync).not.toHaveBeenCalled();
  });

  it("si falla el respaldo previo a restaurar no modifica la base ni queda bloqueado", async () => {
    const { value, services, backups } = mountProvider();
    backups.createLocalBackup.mockRejectedValueOnce(new Error("Respaldo incompleto"));
    await expect(value.restoreLocalData(backupInfo.uri)).rejects.toThrow("Respaldo incompleto");
    expect(backups.restoreLocalBackup).not.toHaveBeenCalled();
    expect(services.resetSyncCooldown).not.toHaveBeenCalled();
    await value.pushSync();
    expect(services.pushOnlySync).toHaveBeenCalledTimes(1);
  });

  it("descartar errores conserva sus datos si falla el respaldo preventivo", async () => {
    const { value, outbox, backups } = mountProvider();
    backups.createLocalBackup.mockRejectedValueOnce(new Error("Archivo no guardado"));
    await expect(value.discardFailedItems()).rejects.toThrow("Archivo no guardado");
    expect(outbox.discardFailed).not.toHaveBeenCalled();
  });
});
