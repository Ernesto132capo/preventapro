import fs from "fs";
import path from "path";
import vm from "vm";
import ts from "typescript";
import type { PerformanceMetric } from "../services/performance";

function walk(node: any, predicate: (node: any) => boolean): any {
  if (Array.isArray(node)) {
    for (const child of node) { const found = walk(child, predicate); if (found) return found; }
  } else if (node && typeof node === "object") {
    if (predicate(node)) return node;
    return walk(node.props?.children, predicate);
  }
}

function textOf(node: any): string {
  if (Array.isArray(node)) return node.map(textOf).join(" ");
  if (typeof node === "string" || typeof node === "number") return String(node);
  return textOf(node?.props?.children || []);
}

function screenHarness(initial: PerformanceMetric[] = []) {
  let snapshot = initial;
  let state: PerformanceMetric[] = [];
  let focused = false;
  let onFocus: (() => void) | null = null;
  const metrics = {
    getPerformanceMetrics: jest.fn(() => snapshot),
    resetPerformanceMetrics: jest.fn(() => { snapshot = []; }),
  };
  const react = {
    createElement: (type: any, props: any, ...children: any[]) => ({ type, props: { ...props, children } }),
    useState: () => [state, (value: PerformanceMetric[]) => { state = value; }],
    useCallback: (callback: any) => callback,
  };
  const dependencies: Record<string, unknown> = {
    react,
    "react-native": { ScrollView: "ScrollView", View: "View", Text: "Text", StyleSheet: { create: (value: unknown) => value } },
    "@react-navigation/native": { useFocusEffect: (callback: () => void) => { if (!focused) onFocus = callback; } },
    "../components/Card": { Card: "Card" },
    "../components/Button": { Button: "Button" },
    "../theme/tokens": { colors: {}, spacing: {} },
    "../services/performance": metrics,
  };
  const file = path.join(__dirname, "../screens/PerformanceScreen.tsx");
  const code = ts.transpileModule(fs.readFileSync(file, "utf8"), { fileName: file, compilerOptions: {
    target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, esModuleInterop: true,
  } }).outputText;
  const module = { exports: {} as { PerformanceScreen?: () => any } };
  vm.runInNewContext(code, { module, exports: module.exports, require: (name: string) => {
    if (!(name in dependencies)) throw new Error(`Dependencia inesperada de rendimiento: ${name}`);
    return dependencies[name];
  } }, { filename: file });
  function render() {
    let tree = module.exports.PerformanceScreen!();
    if (!focused) {
      focused = true;
      (onFocus as (() => void) | null)?.();
      tree = module.exports.PerformanceScreen!();
    }
    return tree;
  }
  return { render, metrics, setSnapshot: (value: PerformanceMetric[]) => { snapshot = value; } };
}

const metric: PerformanceMetric = {
  name: "sale.local_save", count: 4, failures: 1, lastMs: 150, maxMs: 1200,
  totalMs: 2200, lastRecordedAt: "2026-10-27T12:00:00.000Z",
};

describe("Pantalla real de mediciones locales", () => {
  it("explica cómo obtener mediciones cuando la sesión todavía no tiene datos", () => {
    const h = screenHarness();
    const tree = h.render();
    expect(textOf(tree)).toContain("Todavía no hay mediciones");
    expect(textOf(tree)).toContain("Tiempos de esta sesión en este teléfono");
    expect(walk(tree, node => node.type === "Button" && node.props.label === "Borrar mediciones")).toBeUndefined();
  });

  it("muestra última, media, máxima y fallos con nombres comprensibles", () => {
    const h = screenHarness([metric]);
    const text = textOf(h.render());
    expect(text).toContain("Guardar preventa");
    expect(text).toContain("150 ms");
    expect(text).toContain("550 ms");
    expect(text).toContain("1.20 s");
    expect(text).toMatch(/4\s+mediciones\s*·\s*1\s+con fallo/);
    expect(text).not.toContain("sale.local_save");
  });

  it("actualiza el snapshot y borra únicamente las mediciones locales", () => {
    const h = screenHarness();
    let tree = h.render();
    h.setSnapshot([metric]);
    walk(tree, node => node.type === "Button" && node.props.label === "Actualizar mediciones").props.onPress();
    tree = h.render();
    expect(textOf(tree)).toContain("Guardar preventa");
    walk(tree, node => node.type === "Button" && node.props.label === "Borrar mediciones").props.onPress();
    expect(h.metrics.resetPerformanceMetrics).toHaveBeenCalledTimes(1);
    expect(textOf(h.render())).toContain("Todavía no hay mediciones");
    expect(h.metrics.getPerformanceMetrics).toHaveBeenCalledTimes(3);
  });
});
