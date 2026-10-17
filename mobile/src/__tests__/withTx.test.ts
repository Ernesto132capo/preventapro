import { withTx } from "../db/client";

jest.mock("expo-sqlite", () => ({
  openDatabaseAsync: jest.fn(),
}));

describe("withTx Global Serialized Queue Suite", () => {
  it("secuencia dos llamadas concurrentes a withTx sin intercalar", async () => {
    const events: string[] = [];
    const fakeDb = {
      execAsync: jest.fn(async (sql: string) => {
        events.push(`SQL:${sql}`);
      }),
    } as any;

    let resolveTask1!: () => void;
    const task1Promise = new Promise<void>((r) => (resolveTask1 = r));

    const p1 = withTx(async () => {
      events.push("TASK_1_START");
      await task1Promise;
      events.push("TASK_1_END");
      return "res1";
    }, fakeDb);

    const p2 = withTx(async () => {
      events.push("TASK_2_START");
      events.push("TASK_2_END");
      return "res2";
    }, fakeDb);

    // Microtask flush
    await new Promise((r) => setTimeout(r, 5));
    // Task 1 is running; Task 2 must not have started yet.
    expect(events).toEqual(["SQL:BEGIN IMMEDIATE", "TASK_1_START"]);

    resolveTask1();
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(r1).toBe("res1");
    expect(r2).toBe("res2");
    expect(events).toEqual([
      "SQL:BEGIN IMMEDIATE",
      "TASK_1_START",
      "TASK_1_END",
      "SQL:COMMIT",
      "SQL:BEGIN IMMEDIATE",
      "TASK_2_START",
      "TASK_2_END",
      "SQL:COMMIT",
    ]);
  });

  it("hace ROLLBACK y propaga error si la tarea falla, permitiendo a la siguiente ejecutarse", async () => {
    const events: string[] = [];
    const fakeDb = {
      execAsync: jest.fn(async (sql: string) => {
        events.push(`SQL:${sql}`);
      }),
    } as any;

    const p1 = withTx(async () => {
      events.push("TASK_1_FAIL");
      throw new Error("Simulated failure in task 1");
    }, fakeDb);

    const p2 = withTx(async () => {
      events.push("TASK_2_SUCCESS");
      return "ok";
    }, fakeDb);

    await expect(p1).rejects.toThrow("Simulated failure in task 1");
    const r2 = await p2;
    expect(r2).toBe("ok");

    expect(events).toEqual([
      "SQL:BEGIN IMMEDIATE",
      "TASK_1_FAIL",
      "SQL:ROLLBACK",
      "SQL:BEGIN IMMEDIATE",
      "TASK_2_SUCCESS",
      "SQL:COMMIT",
    ]);
  });

  it("espera en cola cuando una tarea previa está activa", async () => {
    const events: string[] = [];
    const fakeDb = {
      execAsync: jest.fn(async (sql: string) => {
        events.push(`SQL:${sql}`);
      }),
    } as any;

    let resolveTask1!: () => void;
    const p1 = withTx(async () => {
      events.push("TASK_1_START");
      await new Promise<void>((r) => (resolveTask1 = r));
      events.push("TASK_1_DONE");
    }, fakeDb);

    let task2Started = false;
    const p2 = withTx(async () => {
      task2Started = true;
      events.push("TASK_2_DONE");
    }, fakeDb);

    await new Promise((r) => setTimeout(r, 10));
    expect(task2Started).toBe(false);

    resolveTask1();
    await Promise.all([p1, p2]);
    expect(task2Started).toBe(true);
    expect(events).toEqual([
      "SQL:BEGIN IMMEDIATE",
      "TASK_1_START",
      "TASK_1_DONE",
      "SQL:COMMIT",
      "SQL:BEGIN IMMEDIATE",
      "TASK_2_DONE",
      "SQL:COMMIT",
    ]);
  });
});
