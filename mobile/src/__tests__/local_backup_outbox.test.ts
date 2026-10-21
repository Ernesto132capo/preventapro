import { LOCAL_SCHEMA } from "../db/schema";
import { withTx } from "../db/client";
import {
  BACKUP_TABLES, createLocalBackup, exportLocalBackup, importLocalBackups, listLocalBackups,
  parseLocalBackup, restoreLocalBackup,
} from "../services/localBackup";
import {
  countUnresolvedOutboxItems, deferForRetry, enqueueInTx, listPending,
  markDone, purgeCompletedOutbox, retryDelayMs,
} from "../db/outbox";
import * as FileSystem from "expo-file-system";

const DatabaseSync = (process as any).getBuiltinModule?.("node:sqlite")?.DatabaseSync;
const sqliteDescribe = DatabaseSync ? describe : describe.skip;
let mockSqlite: any;
let mockUuid = 0;
let mockTxQueue: Promise<void> = Promise.resolve();
const mockFiles = new Map<string, string>();
const mockDirectories = new Set<string>();
const mockDb = {
  runAsync: async (sql: string, params: any[] = []) => mockSqlite.prepare(sql).run(...params),
  getFirstAsync: async (sql: string, params: any[] = []) => mockSqlite.prepare(sql).get(...params) || null,
  getAllAsync: async (sql: string, params: any[] = []) => mockSqlite.prepare(sql).all(...params),
  execAsync: async (sql: string) => mockSqlite.exec(sql),
};
jest.mock("../db/client", () => ({
  getDb: async () => mockDb,
  nowIso: () => new Date().toISOString(),
  withTx: async (callback: any) => {
    const previous = mockTxQueue;
    let release!: () => void;
    mockTxQueue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      mockSqlite.exec("BEGIN IMMEDIATE");
      try {
        const result = await callback(mockDb);
        mockSqlite.exec("COMMIT");
        return result;
      } catch (error) {
        mockSqlite.exec("ROLLBACK");
        throw error;
      }
    } finally { release(); }
  },
}));
jest.mock("uuid", () => ({ v4: () => `generated-${++mockUuid}` }));
jest.mock("react-native", () => ({ Platform: { OS: "android" } }));
jest.mock("expo-file-system", () => ({
  documentDirectory: "file:///app/",
  makeDirectoryAsync: jest.fn(async (uri: string) => { mockDirectories.add(uri); }),
  writeAsStringAsync: jest.fn(async (uri: string, contents: string) => { mockFiles.set(uri, contents); }),
  readAsStringAsync: jest.fn(async (uri: string) => {
    const value = mockFiles.get(uri);
    if (value === undefined) throw new Error("Archivo no encontrado");
    return value;
  }),
  moveAsync: jest.fn(async ({ from, to }: { from: string; to: string }) => {
    const value = mockFiles.get(from);
    if (value === undefined) throw new Error("Archivo temporal no encontrado");
    mockFiles.set(to, value);
    mockFiles.delete(from);
  }),
  deleteAsync: jest.fn(async (uri: string) => { mockFiles.delete(uri); }),
  getInfoAsync: jest.fn(async (uri: string) => ({ exists: mockFiles.has(uri) || mockDirectories.has(uri) })),
  readDirectoryAsync: jest.fn(async (uri: string) => Array.from(mockFiles.keys()).filter((key) => key.startsWith(uri)).map((key) => key.slice(uri.length))),
  StorageAccessFramework: {
    requestDirectoryPermissionsAsync: jest.fn(async () => ({ granted: true, directoryUri: "content://selected-folder" })),
    createFileAsync: jest.fn(async (_directory: string, name: string) => `content://selected-folder/${name}.json`),
    readDirectoryAsync: jest.fn(async (uri: string) => Array.from(mockFiles.keys()).filter((key) => key.startsWith(uri))),
  },
}));

const ts = "2026-10-20T12:00:00.000Z";
const directory = "file:///app/preventapro-backups/";
const scalar = (sql: string) => mockSqlite.prepare(sql).get();
const rows = (table: string) => mockSqlite.prepare(`SELECT * FROM ${table}`).all();
const snapshot = () => Object.fromEntries(BACKUP_TABLES.map((table) => [table, rows(table)]));

async function seedWorkData() {
  await mockDb.runAsync("INSERT INTO meta(key,value) VALUES ('last_pull_at',?)", [ts]);
  await mockDb.runAsync("INSERT INTO categories(id,name) VALUES ('cat','Alimentos')");
  await mockDb.runAsync("INSERT INTO clients(id,business_name,phone,sync_status,created_at,updated_at) VALUES ('client','Tienda','123','pending',?,?)", [ts, ts]);
  await mockDb.runAsync("INSERT INTO products(id,sku,name,category_id,product_type) VALUES ('normal','P1','Papa','cat','standard'),('combo','C1','Combo de papas','cat','combo')");
  await mockDb.runAsync("INSERT INTO product_presentations(id,product_id,name,unit_equivalence,price_cents) VALUES ('normal-pres','normal','Unidad',1,1001),('combo-pres','combo','Combo',1,2000)");
  await mockDb.runAsync("INSERT INTO combo_definitions(id,product_id,selection_min,selection_max) VALUES ('definition','combo',3,3)");
  await mockDb.runAsync("INSERT INTO combo_options(id,combo_id,presentation_id,max_quantity) VALUES ('option','definition','normal-pres',3)");
  await mockDb.runAsync("INSERT INTO work_days(id,user_id,work_date,status,created_at) VALUES ('day','user','2026-10-20','open',?)", [ts]);
  await mockDb.runAsync("INSERT INTO orders(id,work_day_id,client_id,client_name,subtotal_cents,tax_cents,total_cents,item_count,sync_status,created_at,updated_at) VALUES ('order','day','client','Tienda',4000,0,4000,2,'syncing',?,?)", [ts, ts]);
  await mockDb.runAsync("INSERT INTO order_items(id,order_id,product_id,presentation_id,product_name_snapshot,sku_snapshot,presentation_name_snapshot,unit_equivalence_snapshot,unit_price_cents_snapshot,quantity,subtotal_cents) VALUES ('item','order','combo','combo-pres','Combo de papas','C1','Combo',1,2000,2,4000)");
  await mockDb.runAsync("INSERT INTO order_item_selections(id,order_item_id,selected_product_id,selected_presentation_id,product_name_snapshot,presentation_name_snapshot,quantity) VALUES ('selection','item','normal','normal-pres','Papa','Unidad',3)");
  await mockDb.runAsync("INSERT INTO product_favorites(product_id,created_at) VALUES ('normal',?)", [ts]);
  await mockDb.runAsync("INSERT INTO outbox(id,entity_type,local_entity_id,status,attempts,next_retry_at,created_at) VALUES ('queued','order','order','syncing',4,'2099-01-01T00:00:00.000Z',?)", [ts]);
  // Simula credenciales fuera de las tablas de trabajo; nunca deben exportarse.
  mockSqlite.exec("CREATE TABLE credentials(secret TEXT)");
  await mockDb.runAsync("INSERT INTO credentials(secret) VALUES ('AUTH_TOKEN_PRIVATE_DO_NOT_BACK_UP')");
}

sqliteDescribe("Respaldo local y retención del outbox con SQLite real", () => {
  beforeEach(async () => {
    mockSqlite = new DatabaseSync(":memory:");
    mockSqlite.exec(LOCAL_SCHEMA);
    mockFiles.clear();
    mockDirectories.clear();
    mockUuid = 0;
    mockTxQueue = Promise.resolve();
    jest.clearAllMocks();
    await seedWorkData();
  });
  afterEach(() => { jest.useRealTimers(); mockSqlite.close(); });

  it("crea un snapshot completo de pedidos pendientes, combos y favoritos sin credenciales", async () => {
    const before = snapshot();
    const info = await createLocalBackup();
    const contents = mockFiles.get(info.uri)!;
    const backup = parseLocalBackup(contents);
    expect(backup.tables).toEqual(before);
    expect(Object.keys(backup.tables)).toEqual([...BACKUP_TABLES]);
    expect(backup.tables.orders[0]).toMatchObject({ id: "order", total_cents: 4000, sync_status: "syncing" });
    expect(backup.tables.order_item_selections).toHaveLength(1);
    expect(backup.tables.combo_options).toHaveLength(1);
    expect(backup.tables.product_favorites).toHaveLength(1);
    expect(contents).not.toContain("AUTH_TOKEN_PRIVATE_DO_NOT_BACK_UP");
    expect(info).toMatchObject({ orderCount: 1, pendingCount: 1 });
    expect(info.uri).toMatch(/^file:\/\/\/app\/preventapro-backups\/preventapro-.*\.json$/);
    expect(Array.from(mockFiles.keys())).toEqual([info.uri]);
    expect(snapshot()).toEqual(before);
  });

  it("un fallo al escribir el respaldo conserva todos los datos y limpia el temporal", async () => {
    const before = snapshot();
    (FileSystem.writeAsStringAsync as jest.Mock).mockImplementationOnce(async (uri: string, contents: string) => {
      mockFiles.set(uri, contents.slice(0, 20));
      throw new Error("Disco lleno");
    });
    await expect(createLocalBackup()).rejects.toThrow("Disco lleno");
    expect(snapshot()).toEqual(before);
    expect(mockFiles.size).toBe(0);
    expect(FileSystem.moveAsync).not.toHaveBeenCalled();
  });

  it("solo permite reiniciar los datos después de verificar y mover el respaldo definitivo", async () => {
    const afterSave = jest.fn(async (db) => {
      expect(FileSystem.readAsStringAsync).toHaveBeenCalled();
      expect(FileSystem.moveAsync).toHaveBeenCalled();
      const file = Array.from(mockFiles.keys()).find((uri) => uri.endsWith(".json"))!;
      expect(parseLocalBackup(mockFiles.get(file)!).tables.clients).toHaveLength(1);
      await db.runAsync("DELETE FROM clients");
    });
    await createLocalBackup(afterSave);
    expect(afterSave).toHaveBeenCalledTimes(1);
    expect(rows("clients")).toHaveLength(0);
  });

  it("si la verificación del archivo falla no ejecuta el reinicio", async () => {
    const before = snapshot();
    const afterSave = jest.fn(async () => {});
    (FileSystem.readAsStringAsync as jest.Mock).mockResolvedValueOnce("JSON dañado");
    await expect(createLocalBackup(afterSave)).rejects.toThrow(/JSON/);
    expect(afterSave).not.toHaveBeenCalled();
    expect(snapshot()).toEqual(before);
  });

  it("si el callback posterior falla revierte sus cambios y conserva el respaldo verificado", async () => {
    const before = snapshot();
    await expect(createLocalBackup(async (db) => {
      await db.runAsync("DELETE FROM orders");
      throw new Error("Reinicio interrumpido");
    })).rejects.toThrow("Reinicio interrumpido");
    expect(snapshot()).toEqual(before);
    const file = Array.from(mockFiles.keys()).find((uri) => uri.endsWith(".json"))!;
    expect(parseLocalBackup(mockFiles.get(file)!).tables.orders).toHaveLength(1);
  });

  it("una escritura concurrente espera al respaldo y al reinicio dentro de la misma transacción", async () => {
    let enterCallback!: () => void;
    let finishCallback!: () => void;
    const callbackEntered = new Promise<void>((resolve) => { enterCallback = resolve; });
    const callbackGate = new Promise<void>((resolve) => { finishCallback = resolve; });
    const saving = createLocalBackup(async (db) => {
      enterCallback();
      await callbackGate;
      await db.runAsync("DELETE FROM clients");
    });
    await callbackEntered;
    let writerStarted = false;
    const writing = withTx(async (db) => {
      writerStarted = true;
      await db.runAsync("INSERT INTO clients(id,business_name,created_at,updated_at) VALUES ('new','Cliente concurrente',?,?)", [ts, ts]);
    });
    await Promise.resolve();
    expect(writerStarted).toBe(false);
    finishCallback();
    const [backup] = await Promise.all([saving, writing]);
    expect(writerStarted).toBe(true);
    expect(rows("clients")).toMatchObject([{ id: "new", business_name: "Cliente concurrente" }]);
    expect(parseLocalBackup(mockFiles.get(backup.uri)!).tables.clients).toMatchObject([{ id: "client" }]);
  });

  it("restaura el snapshot completo, reinicia el cursor y reencola operaciones interrumpidas", async () => {
    const { uri } = await createLocalBackup();
    const original = parseLocalBackup(mockFiles.get(uri)!);
    for (const table of [...BACKUP_TABLES].reverse()) await mockDb.runAsync(`DELETE FROM ${table}`);
    await mockDb.runAsync("INSERT INTO clients(id,business_name,created_at,updated_at) VALUES ('extra','Dato nuevo',?,?)", [ts, ts]);
    const info = await restoreLocalBackup(uri);
    expect(info).toMatchObject({ uri, orderCount: 1, pendingCount: 1 });
    for (const table of BACKUP_TABLES.filter((table) => !["meta", "orders", "outbox"].includes(table))) {
      expect(rows(table)).toEqual(original.tables[table]);
    }
    expect(scalar("SELECT * FROM orders")).toMatchObject({ ...original.tables.orders[0], sync_status: "pending" });
    expect(scalar("SELECT * FROM outbox")).toMatchObject({ ...original.tables.outbox[0], status: "pending", next_retry_at: null });
    expect(scalar("SELECT value FROM meta WHERE key='last_pull_at'").value).toBe("1970-01-01T00:00:00.000Z");
    expect(scalar("SELECT secret FROM credentials").secret).toBe("AUTH_TOKEN_PRIVATE_DO_NOT_BACK_UP");
    expect(mockFiles.has(uri)).toBe(true);
    expect(await listPending()).toHaveLength(1);
  });

  it.each(["JSON inválido", "tabla ausente", "celda inválida", "columna desconocida", "campo obligatorio ausente", "campo obligatorio nulo"])("rechaza un respaldo con %s antes de borrar los datos actuales", async (kind) => {
    const { uri } = await createLocalBackup();
    const backup: any = JSON.parse(mockFiles.get(uri)!);
    if (kind === "tabla ausente") delete backup.tables.orders;
    if (kind === "celda inválida") backup.tables.orders[0].total_cents = { malicious: true };
    if (kind === "columna desconocida") backup.tables.clients[0].future_column = "dato";
    if (kind === "campo obligatorio ausente") delete backup.tables.clients[0].created_at;
    if (kind === "campo obligatorio nulo") backup.tables.clients[0].created_at = null;
    mockFiles.set(uri, kind === "JSON inválido" ? "{incompleto" : JSON.stringify(backup));
    const before = snapshot();
    const runSpy = jest.spyOn(mockDb, "runAsync");
    try {
      await expect(restoreLocalBackup(uri)).rejects.toThrow();
      expect(snapshot()).toEqual(before);
      expect(runSpy.mock.calls.some(([sql]) => sql.startsWith("DELETE"))).toBe(false);
    } finally { runSpy.mockRestore(); }
  });

  it("un INSERT que viola una restricción SQL revierte toda la restauración", async () => {
    const { uri } = await createLocalBackup();
    const backup: any = JSON.parse(mockFiles.get(uri)!);
    // Todas las columnas son válidas; el segundo registro viola la PK al insertar.
    backup.tables.orders.push({ ...backup.tables.orders[0] });
    mockFiles.set(uri, JSON.stringify(backup));
    await mockDb.runAsync("UPDATE clients SET phone='nuevo teléfono'");
    const before = snapshot();
    await expect(restoreLocalBackup(uri)).rejects.toThrow(/UNIQUE/);
    expect(snapshot()).toEqual(before);
    expect(scalar("SELECT phone FROM clients").phone).toBe("nuevo teléfono");
  });

  it("cancelar la exportación conserva el respaldo local y los pendientes", async () => {
    const { uri } = await createLocalBackup();
    const before = snapshot();
    (FileSystem.StorageAccessFramework.requestDirectoryPermissionsAsync as jest.Mock).mockResolvedValueOnce({ granted: false });
    const writesBefore = (FileSystem.writeAsStringAsync as jest.Mock).mock.calls.length;
    expect(await exportLocalBackup(uri)).toBe(false);
    expect(FileSystem.StorageAccessFramework.createFileAsync).not.toHaveBeenCalled();
    expect((FileSystem.writeAsStringAsync as jest.Mock).mock.calls).toHaveLength(writesBefore);
    expect(mockFiles.has(uri)).toBe(true);
    expect(snapshot()).toEqual(before);
  });

  it("exporta una copia elegida y lista respaldos válidos ignorando temporales y corruptos", async () => {
    const { uri } = await createLocalBackup();
    mockFiles.set(directory + "preventapro-corrupto.json", "invalid");
    mockFiles.set(directory + "preventapro-incompleto.json.tmp", "incompleto");
    expect(await listLocalBackups()).toEqual([expect.objectContaining({ uri, orderCount: 1 })]);
    expect(await exportLocalBackup(uri)).toBe(true);
    const exported = Array.from(mockFiles.keys()).find((key) => key.startsWith("content://"));
    expect(mockFiles.get(exported!)).toBe(mockFiles.get(uri));
  });

  it("importa respaldos exportados válidos sin restaurar SQLite ni aceptar archivos corruptos", async () => {
    const { uri } = await createLocalBackup();
    const contents = mockFiles.get(uri)!;
    mockFiles.clear();
    mockFiles.set("content://selected-folder/PreventaPro-respaldo-valido.json", contents);
    mockFiles.set("content://selected-folder/PreventaPro-respaldo-corrupto.json", "{inválido");
    mockFiles.set("content://selected-folder/archivo-ajeno.json", contents);
    await mockDb.runAsync("UPDATE clients SET phone='dato posterior al backup'");
    const before = snapshot();
    expect(await importLocalBackups()).toBe(1);
    expect(snapshot()).toEqual(before);
    const imported = Array.from(mockFiles.keys()).filter((file) => file.startsWith(directory));
    expect(imported).toHaveLength(1);
    expect(parseLocalBackup(mockFiles.get(imported[0])!).tables.clients[0].phone).toBe("123");
  });

  it("cancelar la carpeta de importación conserva SQLite y no añade archivos", async () => {
    const before = snapshot();
    (FileSystem.StorageAccessFramework.requestDirectoryPermissionsAsync as jest.Mock).mockResolvedValueOnce({ granted: false });
    expect(await importLocalBackups()).toBe(0);
    expect(FileSystem.StorageAccessFramework.readDirectoryAsync).not.toHaveBeenCalled();
    expect(snapshot()).toEqual(before);
    expect(mockFiles.size).toBe(0);
  });

  it.each(["file:///otro/preventapro-a.json", directory + "../preventapro-a.json", directory + "preventapro-a.json/extra"])("no restaura una ruta fuera de los respaldos: %s", async (uri) => {
    const before = snapshot();
    await expect(restoreLocalBackup(uri)).rejects.toThrow(/ruta/);
    expect(snapshot()).toEqual(before);
  });

  it("purga solo eventos done completados hace más de 30 días y fecha los done legacy", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-10-20T12:00:00.000Z"));
    const cases = [
      ["old-done", "done", "2026-09-01T12:00:00.000Z"],
      ["recent-done", "done", "2026-10-15T12:00:00.000Z"],
      ["boundary-done", "done", "2026-09-20T12:00:00.000Z"],
      ["legacy-done", "done", null],
      ["pending", "pending", "2026-01-01T00:00:00.000Z"],
      ["error", "error", "2026-01-01T00:00:00.000Z"],
      ["failed", "failed", "2026-01-01T00:00:00.000Z"],
    ];
    for (const [id, status, completedAt] of cases) {
      await mockDb.runAsync("INSERT INTO outbox(id,entity_type,local_entity_id,status,completed_at,created_at) VALUES (?,'order','order',?,?,?)", [id, status, completedAt, "2026-01-01T00:00:00.000Z"]);
    }
    const ordersBefore = rows("orders");
    expect(await purgeCompletedOutbox()).toBe(1);
    expect(rows("outbox").map((row: any) => row.id)).not.toContain("old-done");
    expect(rows("outbox").map((row: any) => row.id)).toEqual(expect.arrayContaining(["recent-done", "boundary-done", "legacy-done", "pending", "error", "failed", "queued"]));
    expect(scalar("SELECT completed_at FROM outbox WHERE id='legacy-done'").completed_at).toBe("2026-10-20T12:00:00.000Z");
    expect(await purgeCompletedOutbox()).toBe(0);
    expect(await countUnresolvedOutboxItems()).toBe(4);
    expect(rows("orders")).toEqual(ordersBefore);
  });

  it("errores temporales respetan next_retry_at y se reintentan sin límite de intentos", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-10-20T12:00:00.000Z"));
    await mockDb.runAsync("UPDATE outbox SET status='pending',attempts=100,next_retry_at=NULL WHERE id='queued'");
    await deferForRetry("queued", "HTTP 503");
    expect(scalar("SELECT status,attempts,next_retry_at,last_error FROM outbox")).toMatchObject({
      status: "pending", attempts: 101, next_retry_at: "2026-10-20T12:15:00.000Z", last_error: "HTTP 503",
    });
    expect(await listPending()).toHaveLength(0);
    jest.setSystemTime(new Date("2026-10-20T12:14:59.999Z"));
    expect(await listPending()).toHaveLength(0);
    jest.setSystemTime(new Date("2026-10-20T12:15:00.000Z"));
    expect(await listPending()).toHaveLength(1);
    await deferForRetry("queued", "Timeout");
    expect(scalar("SELECT status,attempts FROM outbox")).toMatchObject({ status: "pending", attempts: 102 });
    expect(retryDelayMs(0)).toBe(30_000);
    expect(retryDelayMs(1)).toBe(60_000);
    expect(retryDelayMs(1_000_000)).toBe(900_000);
  });

  it("encolar dentro de la transacción revierte tanto el pedido editado como el evento ante fallo", async () => {
    const before = snapshot();
    await expect(withTx(async (db) => {
      await db.runAsync("UPDATE orders SET total_cents=9999 WHERE id='order'");
      await enqueueInTx(db, "order", "order", 2, "update");
      throw new Error("Error después del enqueue");
    })).rejects.toThrow("Error después del enqueue");
    expect(snapshot()).toEqual(before);
  });

  it("marca una operación completada sin eliminar el pedido ni otras operaciones pendientes", async () => {
    await mockDb.runAsync("INSERT INTO outbox(id,entity_type,local_entity_id,status,created_at) VALUES ('other','client','client','pending',?)", [ts]);
    await markDone("queued");
    expect(scalar("SELECT status,completed_at,next_retry_at FROM outbox WHERE id='queued'")).toMatchObject({ status: "done", next_retry_at: null, completed_at: expect.any(String) });
    expect(scalar("SELECT status FROM outbox WHERE id='other'").status).toBe("pending");
    expect(rows("orders")).toHaveLength(1);
  });
});
