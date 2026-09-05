import React, { createContext, useContext, useEffect, useRef, useState, useCallback } from "react";
import { AppState, AppStateStatus } from "react-native";
import NetInfo from "@react-native-community/netinfo";
import { runSync, pushOnlySync, SyncResult } from "../services/sync";
import { countPending, getFailedErrors, discardFailed } from "../db/outbox";
import { resetLocalDatabase } from "../db/client";
import { useAuth } from "./AuthContext";

export type ConnectionState = "online" | "offline" | "syncing";

interface SyncContextValue {
  connection: ConnectionState;
  pendingCount: number;
  lastSyncedAt: string | null;
  lastError: string | null;
  syncTick: number;
  /** Sync completo (pull + push) — timer periodico y recarga manual */
  forceSync: () => Promise<void>;
  /** Solo push del outbox — usar despues de crear/editar un registro local */
  pushSync: () => Promise<void>;
  discardFailedItems: () => Promise<void>;
  resetLocalData: () => Promise<void>;
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
  const syncingRef = useRef(false);
  const isConnectedRef = useRef(true);
  const isActiveRef = useRef(true);   // false cuando la app esta en background
  const userRef = useRef(user);
  userRef.current = user;
  isConnectedRef.current = isConnected;

  const refreshPendingCount = useCallback(async () => {
    setPendingCount(await countPending());
  }, []);

  const applyResult = useCallback(async (result: SyncResult) => {
    await refreshPendingCount();
    const failedRows = await getFailedErrors();
    if (result.ok && failedRows.length === 0) {
      setLastSyncedAt(new Date().toISOString());
      setLastError(null);
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
  const runForceSyncRef = useRef(async (forcePull = false) => {
    if (!userRef.current || syncingRef.current || !isConnectedRef.current) return;
    syncingRef.current = true;
    setConnection("syncing");
    try {
      const result = await runSync(userRef.current.id, { forcePull });
      await applyResultRef.current(result);
    } catch (err: any) {
      await refreshPendingCount();
      setLastError(err?.message || "Fallo la sincronizacion.");
      setConnection(isConnectedRef.current ? "online" : "offline");
    } finally {
      syncingRef.current = false;
    }
  });

  /** forceSync expuesto al exterior (para botones manuales, reabrir jornada, etc.) */
  const forceSync = useCallback(async () => {
    // El usuario pidió actualizar: no reutilizar la respuesta cacheada del
    // servidor aunque el cursor no haya cambiado todavía.
    await runForceSyncRef.current(true);
  }, []);

  /** pushSync: solo push del outbox sin pull de catalogo.
   *  Usar despues de crear/editar clientes, productos o preventas. */
  const pushSync = useCallback(async () => {
    if (!userRef.current || syncingRef.current) return;
    syncingRef.current = true;
    setConnection("syncing");
    try {
      const result = await pushOnlySync(userRef.current.id);
      await applyResultRef.current(result);
    } catch (err: any) {
      await refreshPendingCount();
      setLastError(err?.message || "Fallo la sincronizacion.");
      setConnection(isConnectedRef.current ? "online" : "offline");
    } finally {
      syncingRef.current = false;
    }
  }, [refreshPendingCount]);

  const discardFailedItems = useCallback(async () => {
    await discardFailed();
    await refreshPendingCount();
    setLastError(null);
  }, [refreshPendingCount]);

  const resetLocalData = useCallback(async () => {
    await resetLocalDatabase();
    setLastError(null);
    await refreshPendingCount();
    await runForceSyncRef.current();
  }, [refreshPendingCount]);

  // Detectar cambios de conectividad
  useEffect(() => {
    const unsubscribe = NetInfo.addEventListener((state) => {
      const online = !!state.isConnected && !!state.isInternetReachable;
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
  // minuto y castigar Firestore cuando nadie modificó datos.
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

  return (
    <SyncContext.Provider
      value={{ connection, pendingCount, lastSyncedAt, lastError, syncTick, forceSync, pushSync, discardFailedItems, resetLocalData }}
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
