import {
  beginPerformanceMeasure, getPerformanceMetrics, measurePerformance, resetPerformanceMetrics,
} from "../services/performance";

describe("Mediciones locales de rendimiento", () => {
  let time = 0;
  let clock: jest.SpyInstance;

  beforeEach(() => {
    resetPerformanceMetrics();
    time = 0;
    clock = jest.spyOn(performance, "now").mockImplementation(() => time);
  });
  afterEach(() => clock.mockRestore());

  it("conserva el resultado y agrega duración, promedio y fallos sin guardar datos del pedido", async () => {
    const result = { clientName: "dato privado", total: 1234 };
    await expect(measurePerformance("sale.local_save", async () => { time += 12; return result; })).resolves.toBe(result);
    const error = new Error("mensaje privado");
    await expect(measurePerformance("sale.local_save", async () => { time += 28; throw error; })).rejects.toBe(error);
    expect(getPerformanceMetrics()).toEqual([
      expect.objectContaining({ name: "sale.local_save", count: 2, failures: 1, lastMs: 28, maxMs: 28, totalMs: 40 }),
    ]);
    expect(JSON.stringify(getPerformanceMetrics())).not.toMatch(/dato privado|mensaje privado|1234/);
  });

  it("cuenta un resultado fallido de sincronización sin convertirlo en una excepción", async () => {
    const result = { ok: false };
    const received = await measurePerformance("sync.full", async () => { time = 30; return result; }, value => value.ok);
    expect(received).toBe(result);
    expect(getPerformanceMetrics()[0]).toMatchObject({ count: 1, failures: 1, totalMs: 30 });
  });

  it("un reinicio invalida tareas en vuelo sin impedir que terminen", async () => {
    let resolve!: (value: string) => void;
    const saving = measurePerformance("sale.local_save", () => new Promise<string>(yes => { resolve = yes; }));
    resetPerformanceMetrics();
    time = 100;
    resolve("guardado");
    await expect(saving).resolves.toBe("guardado");
    expect(getPerformanceMetrics()).toEqual([]);
    await measurePerformance("sale.local_save", async () => { time += 5; });
    expect(getPerformanceMetrics()[0]).toMatchObject({ count: 1, totalMs: 5 });
  });

  it("cierra cada medición una sola vez y mantiene separados tiempos concurrentes", () => {
    const finishFirst = beginPerformanceMeasure("db.transaction_wait");
    time = 5;
    const finishSecond = beginPerformanceMeasure("db.transaction_wait");
    time = 15;
    finishFirst();
    time = 20;
    finishSecond(false);
    finishFirst(false);
    expect(getPerformanceMetrics()[0]).toMatchObject({ count: 2, failures: 1, totalMs: 30, maxMs: 15 });
  });

  it("devuelve copias de los contadores y limita las categorías registradas", () => {
    const finish = beginPerformanceMeasure("sync.push");
    time = 10;
    finish();
    const copy = getPerformanceMetrics();
    copy[0].count = 999;
    expect(getPerformanceMetrics()[0].count).toBe(1);
    beginPerformanceMeasure("identificador privado" as any)();
    expect(getPerformanceMetrics()).toHaveLength(1);
  });

  it("evita duraciones negativas si el reloj de respaldo retrocede", () => {
    const finish = beginPerformanceMeasure("sync.queue_wait");
    time = -1;
    finish();
    expect(getPerformanceMetrics()[0]).toMatchObject({ lastMs: 0, totalMs: 0 });
  });

  it("un fallo del reloj o del clasificador de diagnóstico no altera un guardado correcto", async () => {
    const result = { saved: true };
    clock.mockImplementation(() => { throw new Error("Reloj no disponible"); });
    await expect(measurePerformance("sale.local_save", async () => result)).resolves.toBe(result);
    expect(getPerformanceMetrics()).toEqual([]);
    clock.mockImplementation(() => time);
    await expect(measurePerformance("sale.local_save", async () => result, () => { throw new Error("Diagnóstico"); })).resolves.toBe(result);
  });
});
