import React, { createContext, useContext, useEffect, useRef, useState, useCallback } from "react";
import NetInfo from "@react-native-community/netinfo";
import { runSync, SyncResult } from "../services/sync";
import { countPending, getFailedErrors, discardFailed } from "../db/outbox";
import { resetLocalDatabase } from "../db/client";
import { useAuth } from "./AuthContext";

export type ConnectionState = "online" | "offline" | "syncing";

interface SyncContextValue {
  connection: ConnectionState;
  pendingCount: number;
  lastSyncedAt: string | null;
  lastError: string | null;
  syncTick: number; // incrementa cada vez que termina un sync exitoso
  forceSync: () => Promise<void>;
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
  const syncingRef = useRef(false);

  const refreshPendingCount = useCallback(async () => {
    setPendingCount(await countPending());
  }, []);

  const forceSync = useCallback(async () => {
    if (!user || syncingRef.current) return;
    syncingRef.current = true;
    setConnection("syncing");
    try {
      const result: SyncResult = await runSync(user.id);
      await refreshPendingCount();
      const failedRows = await getFailedErrors();
      if (result.ok && failedRows.length === 0) {
        setLastSyncedAt(new Date().toISOString());
        setLastError(null);
        setConnection("online");
        setSyncTick((t) => t + 1); // notifica a las pantallas que actualicen sus datos
      } else if (result.ok) {
        const detail = failedRows
          .map((r) => `[${r.entity_type}] ${r.last_error || "sin detalle"}`)
          .join(" | ");
        setLastError(`${failedRows.length} elemento(s) con error: ${detail}`);
        setConnection(isConnected ? "online" : "offline");
        setSyncTick((t) => t + 1);
      } else {
        setLastError(result.error || "No se pudo sincronizar.");
        setConnection(isConnected ? "online" : "offline");
      }
    } catch (err: any) {
      await refreshPendingCount();
      setLastError(err?.message || "Falló una operación local durante la sincronización.");
      setConnection(isConnected ? "online" : "offline");
    } finally {
      syncingRef.current = false;
    }
  }, [user, isConnected, refreshPendingCount]);

  const discardFailedItems = useCallback(async () => {
    await discardFailed();
    await refreshPendingCount();
    setLastError(null);
  }, [refreshPendingCount]);

  const resetLocalData = useCallback(async () => {
    await resetLocalDatabase();
    setLastError(null);
    await refreshPendingCount();
    await forceSync();
  }, [forceSync, refreshPendingCount]);

  useEffect(() => {
    const unsubscribe = NetInfo.addEventListener((state) => {
      const online = !!state.isConnected && !!state.isInternetReachable;
      setIsConnected(online);
      if (online && user) {
        forceSync();
      } else {
        setConnection("offline");
      }
    });
    return () => unsubscribe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  useEffect(() => {
    refreshPendingCount();
    const interval = setInterval(() => {
      if (isConnected && user) forceSync();
    }, 15000); // auto-sync cada 15 segundos para reflejar cambios de otros dispositivos
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isConnected, user]);

  return (
    <SyncContext.Provider
      value={{ connection, pendingCount, lastSyncedAt, lastError, syncTick, forceSync, discardFailedItems, resetLocalData }}
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
