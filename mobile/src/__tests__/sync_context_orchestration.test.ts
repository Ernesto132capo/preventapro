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
  forceSync(): Promise<void>;
  pushSync(): Promise<void>;
  backupLocalData(): Promise<unknown>;
  restoreLocalData(uri: string): Promise<void>;
  resetLocalData(): Promise<unknown>;
  discardFailedItems(): Promise<void>;
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

function mountProvider() {
  const services = {
    runSync: jest.fn(async (..._args: any[]) => okResult),
    pushOnlySync: jest.fn(async (..._args: any[]) => okResult),
    withSyncMaintenance: jest.fn(async (operation: () => Promise<unknown>) => operation()),
    resetSyncCooldown: jest.fn(),
  };
  const db = { resetLocalDatabase: jest.fn(async (..._args: any[]) => {}) };
  const outbox = {
    countPending: jest.fn(async () => 1), getFailedErrors: jest.fn(async () => []),
    discardFailed: jest.fn(async () => 1), purgeCompletedOutbox: jest.fn(async () => 0),
  };
  const backups = {
    createLocalBackup: jest.fn(async (..._args: any[]) => backupInfo),
    restoreLocalBackup: jest.fn(async (..._args: any[]) => backupInfo),
  };
  const react = {
    createContext: () => ({ Provider: "SyncContext.Provider" }),
    createElement: (type: unknown, props: any) => ({ type, props }),
    useContext: jest.fn(),
    useEffect: jest.fn(), // No iniciar listeners ni temporizadores en este harness.
    useRef: (value: unknown) => ({ current: value }),
    useState: (value: unknown) => [value, jest.fn()],
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
  return { value, services, db, outbox, backups };
}

describe("Coordinación de acciones públicas de SyncContext", () => {
  it("forceSync espera un push activo antes de iniciar su pull forzado", async () => {
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
    expect(services.runSync).toHaveBeenCalledWith("user-1", { forcePull: true });
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
