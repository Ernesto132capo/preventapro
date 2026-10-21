import React, { createContext, useContext, useEffect, useRef, useState, useCallback } from "react";
import { AppState, AppStateStatus } from "react-native";
import NetInfo from "@react-native-community/netinfo";
import { runSync, pushOnlySync, SyncResult, withSyncMaintenance, resetSyncCooldown } from "../services/sync";
import { countPending, getFailedErrors, discardFailed, purgeCompletedOutbox } from "../db/outbox";
import { resetLocalDatabase } from "../db/client";
import { BackupInfo, createLocalBackup, restoreLocalBackup } from "../services/localBackup";
import { useAuth } from "./AuthContext";

export type ConnectionState = "online" | "offline" | "syncing";

interface SyncContextValue {
  connection: ConnectionState;
  isSyncing: boolean;
  pendingCount: number;
  lastSyncedAt: string | null;
  lastError: string | null;
  syncTick: number;
  /** Sync completo (pull + push) — timer periodico y recarga manual */
  forceSync: () => Promise<void>;
  /** Solo push del outbox — usar despues de crear/editar un registro local */
  pushSync: () => Promise<void>;
  discardFailedItems: () => Promise<void>;
  backupLocalData: () => Promise<BackupInfo>;
  restoreLocalData: (uri: string) => Promise<void>;
  resetLocalData: () => Promise<BackupInfo>;
}

const SyncContext = createContext<SyncContextValue | undefined>(undefined);

export function SyncProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const [isConnected, setIsConnected] = useState<boolean>(true);
  const [connection, setConnection] = useState<ConnectionState>("online");
  const [pendingCount, setPendingCount] = useState(0);
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const [syncTick, setSyncTick] = useState(0);

  // Refs para evitar stale closures en el timer y el listener de AppState
  const activeTaskRef = useRef<Promise<void> | null>(null);
  const lastPurgeRef = useRef(0);
  const pendingPushRef = useRef(false);
  const isConnectedRef = useRef(true);
  const isActiveRef = useRef(true);   // false cuando la app esta en background
  const userRef = useRef(user);
  userRef.current = user;
  isConnectedRef.current = isConnected;

  const refreshPendingCount = useCallback(async () => {
    setPendingCount(await countPending());
  }, []);

  const applyResult = useCallback(async (result: SyncResult) => {
    if (result.ok && Date.now() - lastPurgeRef.current > 86_400_000) {
      await purgeCompletedOutbox();
      lastPurgeRef.current = Date.now();
    }
    await refreshPendingCount();
    const failedRows = await getFailedErrors();
    if (result.ok && failedRows.length === 0) {
      setLastSyncedAt(new Date().toISOString());
      setLastError(
        result.pushed.deferred > 0
          ? `${result.pushed.deferred} elemento(s) quedaron pendientes por conexión, sesión o dependencias; se reintentará en la próxima sincronización.`
          : null
      );
      setConnection("online");
      setSyncTick((t) => t + 1);
    } else if (result.ok) {
      const detail = failedRows
        .map((r) => `[${r.entity_type}] ${r.last_error || "sin detalle"}`)
        .join(" | ");
      setLastError(`${failedRows.length} elemento(s) con error: ${detail}`);
      setConnection(isConnectedRef.current ? "online" : "offline");
      setSyncTick((t) => t + 1);
    } else {
      setLastError(result.error || "No se pudo sincronizar.");
      setConnection(isConnectedRef.current ? "online" : "offline");
    }
  }, [refreshPendingCount]);

  const applyResultRef = useRef(applyResult);
  applyResultRef.current = applyResult;

  /**
   * Sync completo via ref — siempre llama la version actual aunque el timer
   * tenga una closure antigua. Seguro de usar dentro de setInterval.
   */
  const startSyncRef = useRef<(mode: "full" | "push", forcePull?: boolean) => Promise<void>>(async () => {});
  startSyncRef.current = (mode, forcePull = false) => {
    if (activeTaskRef.current) {
      if (mode === "push") pendingPushRef.current = true;
      return activeTaskRef.current;
    }
    const userId = userRef.current?.id;
    if (!userId || !isConnectedRef.current) return refreshPendingCount();
    setConnection("syncing");
    let task!: Promise<void>;
    task = (async () => {
      try {
        let result = mode === "full" ? await runSync(userId, { forcePull }) : await pushOnlySync(userId);
        if (userRef.current?.id === userId) await applyResultRef.current(result);
        // Mantener el mismo lock también durante los envíos solicitados mientras había un pull.
        while (pendingPushRef.current && userRef.current?.id === userId && isConnectedRef.current) {
          pendingPushRef.current = false;
          result = await pushOnlySync(userId);
          if (userRef.current?.id === userId) await applyResultRef.current(result);
        }
      } catch (err: any) {
        await refreshPendingCount();
        setLastError(err?.message || "Falló la sincronización.");
        setConnection(isConnectedRef.current ? "online" : "offline");
      } finally {
        if (activeTaskRef.current === task) activeTaskRef.current = null;
      }
    })();
    activeTaskRef.current = task;
    return task;
  };
  const runForceSyncRef = useRef(async (forcePull = false) => {
    await startSyncRef.current("full", forcePull);
  });

  /** forceSync expuesto al exterior (para botones manuales, reabrir jornada, etc.) */
  const forceSync = useCallback(async () => {
    // El llamador espera la sincronización real antes de cerrar una jornada o recargar datos.
    if (activeTaskRef.current) await activeTaskRef.current.catch(() => undefined);
    await runForceSyncRef.current(true);
  }, []);

  /** pushSync: solo push del outbox sin pull de catalogo.
   *  Usar despues de crear/editar clientes, productos o preventas. */
  const pushSync = useCallback(async () => {
    await startSyncRef.current("push");
  }, []);

  const maintainLocalData = useCallback(async <T,>(operation: () => Promise<T>): Promise<T> => {
    const previous = activeTaskRef.current;
    let value!: T;
    let task!: Promise<void>;
    task = (async () => {
      try {
        if (previous) await previous.catch(() => undefined);
        setConnection("syncing");
        value = await withSyncMaintenance(operation);
      }
      finally {
        if (activeTaskRef.current === task) activeTaskRef.current = null;
        setConnection(isConnectedRef.current ? "online" : "offline");
      }
    })();
    activeTaskRef.current = task;
    await task;
    return value;
  }, []);

  const discardFailedItems = useCallback(async () => {
    await maintainLocalData(async () => { await createLocalBackup(); await discardFailed(); });
    await refreshPendingCount();
    setLastError(null);
  }, [refreshPendingCount, maintainLocalData]);

  const backupLocalData = useCallback(() => maintainLocalData(createLocalBackup), [maintainLocalData]);

  const restoreLocalData = useCallback(async (uri: string) => {
    await maintainLocalData(async () => {
      await createLocalBackup(async (db) => { await restoreLocalBackup(uri, db); });
      resetSyncCooldown();
    });
    await refreshPendingCount();
    setLastError(null);
    setSyncTick((tick) => tick + 1);
  }, [maintainLocalData, refreshPendingCount]);

  const resetLocalData = useCallback(async () => {
    const backup = await maintainLocalData(async () => {
      const saved = await createLocalBackup((db) => resetLocalDatabase(db));
      resetSyncCooldown();
      return saved;
    });
    setLastError(null);
    await refreshPendingCount();
    setSyncTick((tick) => tick + 1);
    await runForceSyncRef.current(true);
    return backup;
  }, [refreshPendingCount, maintainLocalData]);

  // Detectar cambios de conectividad
  useEffect(() => {
    const unsubscribe = NetInfo.addEventListener((state) => {
      const online = Boolean(state.isConnected && state.isInternetReachable !== false);
      setIsConnected(online);
      isConnectedRef.current = online;
      if (online) {
        runForceSyncRef.current();
      } else {
        setConnection("offline");
      }
    });
    return () => unsubscribe();
  }, []);

  // Pausar sync cuando la app va a background; reanudar al volver a foreground
  useEffect(() => {
    const handleAppState = (nextState: AppStateStatus) => {
      if (nextState === "active") {
        isActiveRef.current = true;
        // Al volver a foreground, sincronizar de inmediato si hay conexion
        if (isConnectedRef.current) runForceSyncRef.current();
      } else {
        isActiveRef.current = false;
      }
    };
    const sub = AppState.addEventListener("change", handleAppState);
    return () => sub.remove();
  }, []);

  // Timer periódico de baja frecuencia. Las mutaciones usan pushSync y al volver
  // a foreground se hace pull inmediato, por lo que no hace falta sondear cada
  // minuto y consultar el backend cuando nadie modificó datos.
  useEffect(() => {
    refreshPendingCount();
    // Sync inicial al montar
    runForceSyncRef.current();

    const interval = setInterval(() => {
      if (isActiveRef.current && isConnectedRef.current) {
        runForceSyncRef.current();
      }
    }, 5 * 60 * 1000); // 5 minutos; el backend además cachea por cursor
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // La autenticación puede restaurarse desde AsyncStorage después del montaje inicial,
  // o el usuario puede volver a entrar tras un 401/logout. Retomar la cola al tener sesión.
  useEffect(() => {
    if (user && isConnectedRef.current) {
      runForceSyncRef.current();
    }
  }, [user?.id]);

  return (
    <SyncContext.Provider
      value={{ connection, isSyncing: connection === "syncing", pendingCount, lastSyncedAt, lastError, syncTick, forceSync, pushSync, discardFailedItems, backupLocalData, restoreLocalData, resetLocalData }}
    >
      {children}
    </SyncContext.Provider>
  );
}

export function useSync() {
  const ctx = useContext(SyncContext);
  if (!ctx) throw new Error("useSync debe usarse dentro de SyncProvider");
  return ctx;
}
