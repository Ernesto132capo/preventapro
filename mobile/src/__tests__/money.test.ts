import { parseBsToCents } from "../utils/money";

describe("parseBsToCents — entrada exacta de precios y costos", () => {
  it("convierte enteros a centavos", () => {
    expect(parseBsToCents("10")).toBe(1000);
    expect(parseBsToCents("0")).toBe(0);
    expect(parseBsToCents("1234")).toBe(123400);
  });

  it("acepta punto decimal con 1 o 2 decimales", () => {
    expect(parseBsToCents("10.5")).toBe(1050);
    expect(parseBsToCents("10.50")).toBe(1050);
    expect(parseBsToCents("0.05")).toBe(5);
  });

  it("acepta coma decimal", () => {
    expect(parseBsToCents("10,50")).toBe(1050);
    expect(parseBsToCents("0,05")).toBe(5);
  });

  it("no redondea decimales adicionales (conversión exacta)", () => {
    expect(Number.isNaN(parseBsToCents("1.999"))).toBe(true);
    expect(Number.isNaN(parseBsToCents("10.999"))).toBe(true);
  });

  it("rechaza entradas ambiguas o inválidas", () => {
    expect(Number.isNaN(parseBsToCents("1.2.3"))).toBe(true);
    expect(Number.isNaN(parseBsToCents("1,2,3"))).toBe(true);
    expect(Number.isNaN(parseBsToCents("1,000"))).toBe(true); // miles vs coma decimal
    expect(Number.isNaN(parseBsToCents("abc"))).toBe(true);
    expect(Number.isNaN(parseBsToCents("-5"))).toBe(true);
    expect(Number.isNaN(parseBsToCents(".5"))).toBe(true);
  });

  it("trata el texto vacío como 0 (monto libre)", () => {
    expect(parseBsToCents("")).toBe(0);
    expect(parseBsToCents("   ")).toBe(0);
  });
});
