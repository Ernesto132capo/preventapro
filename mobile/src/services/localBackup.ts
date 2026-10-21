import * as FileSystem from "expo-file-system";
import { Platform } from "react-native";
import { v4 as uuid } from "uuid";
import type { SQLiteDatabase } from "expo-sqlite";
import { getDb, nowIso, withTx } from "../db/client";

// El respaldo contiene datos de trabajo. Las credenciales permanecen en SecureStore.
export const BACKUP_TABLES = [
  "meta", "categories", "clients", "products", "product_presentations",
  "combo_definitions", "combo_options", "work_days", "orders", "order_items",
  "order_item_selections", "product_favorites", "outbox",
] as const;
type TableName = typeof BACKUP_TABLES[number];
type Cell = string | number | null;
type BackupRow = Record<string, Cell>;

export interface LocalBackup {
  format: "preventapro-local-backup";
  version: 1;
  createdAt: string;
  tables: Record<TableName, BackupRow[]>;
}

export interface BackupInfo {
  uri: string;
  createdAt: string;
  orderCount: number;
  pendingCount: number;
}

function backupDirectory(): string {
  if (!FileSystem.documentDirectory) throw new Error("El teléfono no permite guardar el respaldo local.");
  return `${FileSystem.documentDirectory}preventapro-backups/`;
}

export function parseLocalBackup(json: string): LocalBackup {
  let data: any;
  try { data = JSON.parse(json); } catch { throw new Error("El respaldo no contiene un JSON válido."); }
  if (data?.format !== "preventapro-local-backup" || data.version !== 1 ||
      typeof data.createdAt !== "string" || !Number.isFinite(Date.parse(data.createdAt)) ||
      !data.tables || typeof data.tables !== "object") {
    throw new Error("Este archivo no es un respaldo compatible de PreventaPro.");
  }
  for (const table of BACKUP_TABLES) {
    if (!Array.isArray(data.tables[table])) throw new Error(`El respaldo está incompleto: falta ${table}.`);
    for (const row of data.tables[table]) {
      if (!row || typeof row !== "object" || Array.isArray(row) ||
          Object.entries(row).some(([key, value]) => !/^[a-z_]+$/.test(key) ||
            !(value === null || typeof value === "string" || (typeof value === "number" && Number.isFinite(value))))) {
        throw new Error(`El respaldo contiene datos inválidos en ${table}.`);
      }
    }
  }
  return data as LocalBackup;
}

function infoFor(backup: LocalBackup, uri: string): BackupInfo {
  return {
    uri,
    createdAt: backup.createdAt,
    orderCount: backup.tables.orders.length,
    pendingCount: backup.tables.outbox.filter((row) => row.status !== "done").length,
  };
}

/** Snapshot coherente y escritura verificada antes de permitir cualquier reinicio. */
export async function createLocalBackup(afterSave?: (db: SQLiteDatabase) => Promise<void>): Promise<BackupInfo> {
  const tables = {} as LocalBackup["tables"];
  return withTx(async (db) => {
    for (const table of BACKUP_TABLES) tables[table] = await db.getAllAsync<BackupRow>(`SELECT * FROM ${table}`);
    const backup: LocalBackup = { format: "preventapro-local-backup", version: 1, createdAt: nowIso(), tables };
    const directory = backupDirectory();
    await FileSystem.makeDirectoryAsync(directory, { intermediates: true });
    const fileName = `preventapro-${backup.createdAt.replace(/[:.]/g, "-")}-${uuid()}.json`;
    const uri = directory + fileName;
    const temporaryUri = uri + ".tmp";
    try {
      await FileSystem.writeAsStringAsync(temporaryUri, JSON.stringify(backup));
      const verified = parseLocalBackup(await FileSystem.readAsStringAsync(temporaryUri));
      await FileSystem.moveAsync({ from: temporaryUri, to: uri });
      // Mantener el mismo lock de escritura hasta terminar un reinicio/restauración.
      // Una venta guardada durante el I/O se ejecutará después, sin perderse.
      if (afterSave) await afterSave(db);
      return infoFor(verified, uri);
    } catch (error) {
      await FileSystem.deleteAsync(temporaryUri, { idempotent: true }).catch(() => undefined);
      throw error;
    }
  });
}

export async function listLocalBackups(): Promise<BackupInfo[]> {
  const directory = backupDirectory();
  const info = await FileSystem.getInfoAsync(directory);
  if (!info.exists) return [];
  const names = (await FileSystem.readDirectoryAsync(directory)).filter((name) => /^preventapro-.*\.json$/.test(name)).sort().reverse();
  const result: BackupInfo[] = [];
  for (const name of names) {
    try {
      const uri = directory + name;
      result.push(infoFor(parseLocalBackup(await FileSystem.readAsStringAsync(uri)), uri));
    } catch {
      // Un archivo dañado no oculta los otros respaldos recuperables.
    }
  }
  return result;
}

/** Conserva el original local y copia a la carpeta elegida por el usuario en Android. */
export async function exportLocalBackup(uri: string): Promise<boolean> {
  if (Platform.OS !== "android") throw new Error("La exportación a una carpeta está disponible en Android.");
  const contents = await FileSystem.readAsStringAsync(uri);
  const backup = parseLocalBackup(contents);
  const permission = await FileSystem.StorageAccessFramework.requestDirectoryPermissionsAsync();
  if (!permission.granted) return false;
  const name = `PreventaPro-respaldo-${backup.createdAt.replace(/[:.]/g, "-")}`;
  const destination = await FileSystem.StorageAccessFramework.createFileAsync(permission.directoryUri, name, "application/json");
  await FileSystem.writeAsStringAsync(destination, contents);
  return true;
}

/** Recupera copias exportadas incluso después de reinstalar la app. No restaura aún la base. */
export async function importLocalBackups(): Promise<number> {
  if (Platform.OS !== "android") throw new Error("La importación desde una carpeta está disponible en Android.");
  const permission = await FileSystem.StorageAccessFramework.requestDirectoryPermissionsAsync();
  if (!permission.granted) return 0;
  const files = await FileSystem.StorageAccessFramework.readDirectoryAsync(permission.directoryUri);
  const directory = backupDirectory();
  await FileSystem.makeDirectoryAsync(directory, { intermediates: true });
  let imported = 0;
  for (const file of files) {
    try {
      if (!decodeURIComponent(file).toLowerCase().includes("preventapro-respaldo-")) continue;
      const contents = await FileSystem.readAsStringAsync(file);
      const backup = parseLocalBackup(contents);
      const uri = `${directory}preventapro-${backup.createdAt.replace(/[:.]/g, "-")}-${uuid()}.json`;
      await FileSystem.writeAsStringAsync(uri, JSON.stringify(backup));
      imported++;
    } catch {
      // Una copia incompleta no impide recuperar las demás; SQLite sigue intacto.
    }
  }
  return imported;
}

/** Solo lee archivos de la carpeta de respaldos de la app; no acepta SQL ni rutas arbitrarias. */
export async function restoreLocalBackup(uri: string, existingDb?: SQLiteDatabase): Promise<BackupInfo> {
  const directory = backupDirectory();
  if (!uri.startsWith(directory) || !/^preventapro-[^/\\]+\.json$/.test(uri.slice(directory.length))) {
    throw new Error("La ruta del respaldo no es válida.");
  }
  const backup = parseLocalBackup(await FileSystem.readAsStringAsync(uri));
  const db = existingDb || await getDb();
  // Validar todas las columnas antes de borrar datos; si falla un INSERT se revierte todo.
  for (const table of BACKUP_TABLES) {
    const columns = await db.getAllAsync<{ name: string; notnull: number; dflt_value: string | null; pk: number }>(`PRAGMA table_info(${table})`);
    const allowed = new Set(columns.map((column) => column.name));
    if (backup.tables[table].some((row) => Object.keys(row).some((column) => !allowed.has(column)))) {
      throw new Error("El respaldo pertenece a una versión más reciente de la app. Actualiza antes de restaurarlo.");
    }
    const required = columns.filter((column) => column.pk > 0 || (column.notnull === 1 && column.dflt_value === null));
    if (backup.tables[table].some((row) => required.some((column) => row[column.name] === undefined || row[column.name] === null))) {
      throw new Error(`El respaldo está incompleto: faltan campos obligatorios en ${table}.`);
    }
  }
  const restore = async (txDb: SQLiteDatabase) => {
    for (const table of [...BACKUP_TABLES].reverse()) await txDb.runAsync(`DELETE FROM ${table}`);
    for (const table of BACKUP_TABLES) {
      for (const row of backup.tables[table]) {
        const columns = Object.keys(row);
        if (columns.length === 0) throw new Error(`Fila vacía en ${table}.`);
        await txDb.runAsync(`INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`, columns.map((key) => row[key]));
      }
    }
    await txDb.runAsync(`UPDATE outbox SET status = 'pending', next_retry_at = NULL WHERE status = 'syncing'`);
    await txDb.runAsync(`UPDATE orders SET sync_status = 'pending' WHERE sync_status = 'syncing'`);
    await txDb.runAsync(`INSERT INTO meta (key, value) VALUES ('last_pull_at', '1970-01-01T00:00:00.000Z') ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
  };
  if (existingDb) await restore(existingDb);
  else await withTx(restore, db);
  return infoFor(backup, uri);
}
