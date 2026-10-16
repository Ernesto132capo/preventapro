import { describe, it, expect, vi } from "vitest";
import { batchLoadProducts, resolveCategoryId, UUID_REGEX } from "../routes/catalog";

describe("Catálogo: Optimización de consultas en lote y resolución segura de categorías", () => {
  describe("UUID_REGEX", () => {
    it("identifica UUIDs válidos en minúsculas y mayúsculas", () => {
      expect(UUID_REGEX.test("550e8400-e29b-41d4-a716-446655440000")).toBe(true);
      expect(UUID_REGEX.test("B4F22C54-D971-46B9-A8F8-632D157A3C8B")).toBe(true);
    });

    it("no confunde nombres de categorías legítimos con UUIDs", () => {
      expect(UUID_REGEX.test("Bebidas")).toBe(false);
      expect(UUID_REGEX.test("Lácteos y Derivados")).toBe(false);
      expect(UUID_REGEX.test("Combo-1")).toBe(false);
      expect(UUID_REGEX.test("12345")).toBe(false);
    });
  });

  describe("batchLoadProducts [A-08]", () => {
    it("devuelve arreglo vacío sin ejecutar queries si no hay productos", async () => {
      const mockQuery = vi.fn();
      const mockClient = { query: mockQuery } as any;

      const result = await batchLoadProducts([], mockClient);
      expect(result).toEqual([]);
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it("resuelve 10 productos estándar en exactamente 1 sola consulta en lote (eliminando N+1)", async () => {
      const products = Array.from({ length: 10 }, (_, i) => ({
        id: `prod-${i}`,
        sku: `SKU-${i}`,
        name: `Producto ${i}`,
        category_id: "cat-1",
        photo_url: null,
        base_cost_cents: 100,
        base_unit_name: "Unidad",
        product_type: "standard",
        active: true,
        created_at: "2026-10-16T12:00:00.000Z",
        updated_at: "2026-10-16T12:00:00.000Z",
      }));

      const presentationsRows = products.flatMap((p) => [
        {
          id: `pres-${p.id}-1`,
          product_id: p.id,
          name: "Unidad",
          sort_order: 0,
          unit_equivalence: 1,
          price_cents: 150,
          cost_cents: 100,
          active: true,
          created_at: "2026-10-16T12:00:00.000Z",
          updated_at: "2026-10-16T12:00:00.000Z",
        },
        {
          id: `pres-${p.id}-2`,
          product_id: p.id,
          name: "Caja x12",
          sort_order: 1,
          unit_equivalence: 12,
          price_cents: 1600,
          cost_cents: 1100,
          active: true,
          created_at: "2026-10-16T12:00:00.000Z",
          updated_at: "2026-10-16T12:00:00.000Z",
        },
      ]);

      const mockQuery = vi.fn().mockImplementation(async (sql: string, params: any[]) => {
        if (sql.includes("FROM product_presentations")) {
          expect(params[0]).toHaveLength(10);
          return { rows: presentationsRows };
        }
        throw new Error(`Consulta inesperada: ${sql}`);
      });

      const mockClient = { query: mockQuery } as any;

      const loaded = await batchLoadProducts(products, mockClient);

      // Verificación: Solo 1 query ejecutada para los 10 productos (O(1))
      expect(mockQuery).toHaveBeenCalledTimes(1);
      expect(loaded).toHaveLength(10);
      for (const p of loaded) {
        expect(p.presentations).toHaveLength(2);
        expect(p.presentations[0].name).toBe("Unidad");
        expect(p.presentations[1].name).toBe("Caja x12");
        expect(p.combo_definition).toBeNull();
      }
    });

    it("resuelve productos combo y estándar conjuntamente con solo 3 consultas en lote", async () => {
      const products = [
        {
          id: "prod-std",
          sku: "STD-1",
          name: "Gaseosa 2L",
          category_id: "cat-1",
          product_type: "standard",
          active: true,
        },
        {
          id: "prod-combo",
          sku: "CMB-1",
          name: "Pack Fiestas",
          category_id: "cat-1",
          product_type: "combo",
          active: true,
        },
      ];

      const mockQuery = vi.fn().mockImplementation(async (sql: string, params: any[]) => {
        if (sql.includes("FROM product_presentations")) {
          return {
            rows: [
              {
                id: "pres-1",
                product_id: "prod-std",
                name: "Botella 2L",
                sort_order: 0,
                unit_equivalence: 1,
                price_cents: 1200,
                cost_cents: 800,
                active: true,
              },
              {
                id: "pres-2",
                product_id: "prod-combo",
                name: "Pack Completo",
                sort_order: 0,
                unit_equivalence: 1,
                price_cents: 2500,
                cost_cents: 1800,
                active: true,
              },
            ],
          };
        }
        if (sql.includes("FROM combo_definitions")) {
          return {
            rows: [
              {
                id: "cdef-1",
                product_id: "prod-combo",
                selection_min: 2,
                selection_max: 4,
                active: true,
                created_at: "2026-10-16T12:00:00.000Z",
                updated_at: "2026-10-16T12:00:00.000Z",
              },
            ],
          };
        }
        if (sql.includes("FROM combo_options co")) {
          return {
            rows: [
              {
                id: "copt-1",
                combo_id: "cdef-1",
                presentation_id: "pres-1",
                product_id: "prod-std",
                product_name: "Gaseosa 2L",
                presentation_name: "Botella 2L",
                max_quantity: 2,
                sort_order: 0,
                active: true,
              },
            ],
          };
        }
        throw new Error(`Query inesperada: ${sql}`);
      });

      const mockClient = { query: mockQuery } as any;

      const loaded = await batchLoadProducts(products, mockClient);

      expect(mockQuery).toHaveBeenCalledTimes(3);
      expect(loaded[0].combo_definition).toBeNull();
      expect(loaded[1].combo_definition).not.toBeNull();
      expect(loaded[1].combo_definition?.selection_min).toBe(2);
      expect(loaded[1].combo_definition?.options).toHaveLength(1);
      expect(loaded[1].combo_definition?.options[0].presentation_name).toBe("Botella 2L");
    });
  });

  describe("resolveCategoryId [M-05]", () => {
    it("devuelve el ID existente si la categoría se encuentra en la base de datos", async () => {
      const mockQuery = vi.fn().mockImplementation(async (sql: string, params: any[]) => {
        if (sql.includes("FROM categories WHERE id = $1")) {
          return { rows: [{ id: params[0], active: true }] };
        }
        return { rows: [] };
      });
      const mockClient = { query: mockQuery } as any;

      const catId = await resolveCategoryId(mockClient, "d290f1ee-6c54-4b01-90e6-d701748f0851");
      expect(catId).toBe("d290f1ee-6c54-4b01-90e6-d701748f0851");
      expect(mockQuery).toHaveBeenCalledTimes(1);
    });

    it("reactiva la categoría si estaba inactiva (active = false)", async () => {
      const mockQuery = vi.fn().mockImplementation(async (sql: string, params: any[]) => {
        if (sql.includes("FROM categories WHERE id = $1")) {
          return { rows: [{ id: params[0], active: false }] };
        }
        if (sql.includes("UPDATE categories SET active = true")) {
          return { rowCount: 1 };
        }
        return { rows: [] };
      });
      const mockClient = { query: mockQuery } as any;

      const catId = await resolveCategoryId(mockClient, "d290f1ee-6c54-4b01-90e6-d701748f0851");
      expect(catId).toBe("d290f1ee-6c54-4b01-90e6-d701748f0851");
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("UPDATE categories SET active = true"),
        expect.any(Array)
      );
    });

    it("asigna null y NUNCA crea una categoría con nombre de UUID si el ID es un UUID huérfano", async () => {
      const mockQuery = vi.fn().mockResolvedValue({ rows: [] });
      const mockClient = { query: mockQuery } as any;

      const catId = await resolveCategoryId(mockClient, "a8098c1a-f86e-11da-bd1a-00112444be1e");
      expect(catId).toBeNull();

      // Verificar que NO se ejecutó ningún INSERT INTO categories
      const insertCalls = mockQuery.mock.calls.filter((call: any[]) => typeof call[0] === "string" && call[0].includes("INSERT INTO categories"));
      expect(insertCalls).toHaveLength(0);
    });

    it("crea la categoría normalmente si el argumento es un nombre textual (no UUID)", async () => {
      const mockQuery = vi.fn().mockImplementation(async (sql: string, params: any[]) => {
        if (sql.includes("FROM categories WHERE id = $1")) {
          return { rows: [] };
        }
        if (sql.includes("FROM categories WHERE lower(name) = lower($1)")) {
          return { rows: [] };
        }
        if (sql.includes("INSERT INTO categories")) {
          return { rowCount: 1 };
        }
        return { rows: [] };
      });
      const mockClient = { query: mockQuery } as any;

      const catId = await resolveCategoryId(mockClient, "Bebidas Isotónicas");
      expect(catId).toBeDefined();
      expect(catId).not.toBeNull();

      const insertCall = mockQuery.mock.calls.find((call: any[]) => typeof call[0] === "string" && call[0].includes("INSERT INTO categories"));
      expect(insertCall).toBeDefined();
      expect(insertCall![1][1]).toBe("Bebidas Isotónicas"); // Nombre visible debe ser el texto legítimo
    });

    it("usa categoryName si viene acompañado de un UUID huérfano", async () => {
      const mockQuery = vi.fn().mockImplementation(async (sql: string, params: any[]) => {
        if (sql.includes("FROM categories WHERE id = $1")) {
          return { rows: [] };
        }
        if (sql.includes("FROM categories WHERE lower(name) = lower($1)")) {
          return { rows: [] };
        }
        if (sql.includes("INSERT INTO categories")) {
          return { rowCount: 1 };
        }
        return { rows: [] };
      });
      const mockClient = { query: mockQuery } as any;

      const catId = await resolveCategoryId(
        mockClient,
        "550e8400-e29b-41d4-a716-446655440000",
        "Golosinas y Confites"
      );
      expect(catId).toBe("550e8400-e29b-41d4-a716-446655440000");

      const insertCall = mockQuery.mock.calls.find((call: any[]) => typeof call[0] === "string" && call[0].includes("INSERT INTO categories"));
      expect(insertCall).toBeDefined();
      expect(insertCall![1][1]).toBe("Golosinas y Confites"); // No el UUID
    });
  });
});
