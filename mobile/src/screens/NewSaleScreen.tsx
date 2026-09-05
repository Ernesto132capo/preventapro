import React, { useCallback, useEffect, useMemo, useState } from "react";
import { View, Text, TextInput, FlatList, StyleSheet, Pressable, ScrollView, Alert } from "react-native";
import { useFocusEffect, useNavigation, useRoute } from "@react-navigation/native";
import { colors, spacing, radius, touchTarget } from "../theme/tokens";
import { Card } from "../components/Card";
import { Button } from "../components/Button";
import { EmptyState } from "../components/EmptyState";
import { getClient, listActiveClients } from "../db/repositories/clients";
import { listProducts, ProductWithPresentations } from "../db/repositories/products";
import { createOrderLocal, getOrderWithItems, updateOrderLocal } from "../db/repositories/orders";
import { getTodayWorkDay, reopenWorkDayLocal, resolveServerWorkDayId } from "../db/repositories/workdays";
import { buildCartLine, calcOrderTotals, recalcLineQuantity, PricingError } from "../domain/pricing";
import { centsToBs } from "../domain/pricing";
import { CartLine, Client, Presentation, Product, WorkDay } from "../domain/types";
import { useAuth } from "../context/AuthContext";
import { useSync } from "../context/SyncContext";
import { apiFetch } from "../services/api";

type Step = "client" | "products";

export function NewSaleScreen() {
  const navigation = useNavigation<any>();
  const route = useRoute<any>();
  const { user } = useAuth();
  const { forceSync } = useSync();

  const [workDay, setWorkDay] = useState<WorkDay | null>(null);
  const [step, setStep] = useState<Step>("client");
  const [clientSearch, setClientSearch] = useState("");
  const [clients, setClients] = useState<Client[]>([]);
  const [selectedClient, setSelectedClient] = useState<Client | null>(null);

  const [productSearch, setProductSearch] = useState("");
  const [products, setProducts] = useState<ProductWithPresentations[]>([]);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [paymentCondition] = useState("Contado 48h");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const editingOrderId = route.params?.orderId as string | undefined;

  const checkWorkDay = useCallback(async () => {
    if (!user) return;
    const wd = await getTodayWorkDay(user.id);
    setWorkDay(wd);
  }, [user]);

  const loadClients = useCallback(async () => {
    setClients(await listActiveClients(clientSearch));
  }, [clientSearch]);

  const loadProducts = useCallback(async () => {
    setProducts(await listProducts(productSearch));
  }, [productSearch]);

  useFocusEffect(
    useCallback(() => {
      checkWorkDay();
      loadClients();
      loadProducts();
    }, [checkWorkDay, loadClients, loadProducts])
  );

  async function handleReopen() {
    if (!workDay) return;
    try {
      const serverId = await resolveServerWorkDayId(workDay.id);
      if (serverId) {
        await apiFetch(`/workdays/${serverId}/reopen`, { method: "POST" });
      }
      await reopenWorkDayLocal(workDay.id);
      await forceSync();
      await checkWorkDay();
      Alert.alert("Jornada reabierta", "Ahora puedes continuar registrando pedidos.");
    } catch (e: any) {
      Alert.alert("Error al reabrir", e?.message || "No se pudo reabrir la jornada.");
    }
  }

  useEffect(() => {
    if (route.params?.preselectedClientId) {
      listActiveClients().then((all) => {
        const c = all.find((x) => x.id === route.params.preselectedClientId);
        if (c) {
          setSelectedClient(c);
          setStep("products");
        }
      });
    }
  }, [route.params?.preselectedClientId]);

  // Al editar, reconstruye el carrito usando el snapshot de la preventa.
  useEffect(() => {
    if (!editingOrderId) return;
    getOrderWithItems(editingOrderId).then(async ({ order, items }) => {
      if (!order) return;
      const client = await getClient(order.client_id);
      if (client) setSelectedClient(client);
      setCart(items.map((item: any) => ({
        productId: item.product_id, presentationId: item.presentation_id,
        productName: item.product_name_snapshot, sku: item.sku_snapshot,
        presentationName: item.presentation_name_snapshot,
        unitEquivalence: item.unit_equivalence_snapshot,
        unitPriceCents: item.unit_price_cents_snapshot,
        quantity: item.quantity, subtotalCents: item.subtotal_cents,
      })));
      setStep("products");
    });
  }, [editingOrderId]);

  const totals = useMemo(() => {
    try {
      return calcOrderTotals(cart, 0);
    } catch {
      return { subtotalCents: 0, taxCents: 0, totalCents: 0, itemCount: 0 };
    }
  }, [cart]);

  function addToCart(product: Product, presentation: Presentation, quantity: number) {
    try {
      const existingIdx = cart.findIndex((l) => l.presentationId === presentation.id);
      if (existingIdx >= 0) {
        const updated = recalcLineQuantity(cart[existingIdx], cart[existingIdx].quantity + quantity);
        setCart((prev) => prev.map((l, i) => (i === existingIdx ? updated : l)));
      } else {
        const line = buildCartLine(product, presentation, quantity);
        setCart((prev) => [...prev, line]);
      }
    } catch (err) {
      if (err instanceof PricingError) Alert.alert("No se pudo agregar", err.message);
    }
  }

  function changeQuantity(presentationId: string, delta: number) {
    setCart((prev) =>
      prev
        .map((l) => (l.presentationId === presentationId ? { ...l, quantity: l.quantity + delta } : l))
        .filter((l) => l.quantity > 0)
        .map((l) => (l.quantity > 0 ? recalcLineQuantity(l, l.quantity) : l))
    );
  }

  function removeLine(presentationId: string) {
    setCart((prev) => prev.filter((l) => l.presentationId !== presentationId));
  }

  async function handleSaveOrder() {
    setError(null);
    if (!selectedClient) {
      setError("Selecciona un cliente antes de guardar.");
      return;
    }
    if (cart.length === 0) {
      setError("Agrega al menos un producto.");
      return;
    }
    setSaving(true);
    try {
      const currentWd = await getTodayWorkDay(user!.id);
      if (currentWd.status === "closed") {
        setError("La jornada de hoy está concluida. Debes reabrir la jornada para registrar preventas.");
        setSaving(false);
        return;
      }
      if (editingOrderId) {
        await updateOrderLocal(editingOrderId, cart, paymentCondition);
      } else {
        await createOrderLocal({
          workDayLocalId: currentWd.id,
          clientId: selectedClient.id,
          paymentCondition,
          lines: cart,
        });
      }
      // En cuanto se guarda, intenta subirla sin esperar a una recarga ni al
      // intervalo automático de sincronización.
      await forceSync();
      setSaving(false);
      setCart([]);
      setSelectedClient(null);
      setStep("client");
      Alert.alert(editingOrderId ? "Preventa actualizada" : "Preventa guardada", "Se sincronizará automáticamente.");
      if (editingOrderId) navigation.goBack();
      else navigation.navigate("Registros");
    } catch (err: any) {
      setSaving(false);
      setError(err.message || "No se pudo guardar la preventa.");
    }
  }

  if (workDay?.status === "closed") {
    return (
      <View style={[styles.screen, { justifyContent: "center", alignItems: "center", padding: spacing.xl }]}>
        <Card style={{ width: "100%", padding: spacing.xl, alignItems: "center" }}>
          <Text style={{ fontSize: 44, marginBottom: spacing.md }}>🔒</Text>
          <Text style={{ fontSize: 20, fontWeight: "700", color: colors.navy, textAlign: "center", marginBottom: spacing.xs }}>
            Jornada Concluida
          </Text>
          <Text style={{ fontSize: 14, color: colors.textSecondary, textAlign: "center", marginBottom: spacing.xl, lineHeight: 20 }}>
            La jornada de hoy ya fue finalizada. Para registrar nuevas preventas o editar pedidos existentes, primero debes reabrir la jornada.
          </Text>
          <Button
            label="Reabrir Jornada"
            variant="secondary"
            onPress={handleReopen}
            style={{ width: "100%", marginBottom: spacing.sm }}
          />
          <Button
            label="Volver al Inicio"
            variant="outline"
            onPress={() => navigation.navigate("Inicio")}
            style={{ width: "100%" }}
          />
        </Card>
      </View>
    );
  }

  if (step === "client") {
    return (
      <View style={styles.screen}>
        <View style={styles.stepHeader}>
          <Text style={styles.stepTitle}>{editingOrderId ? "Editar preventa" : "Paso 1: Cliente"}</Text>
          <Text style={styles.stepSub}>Selecciona el cliente para esta preventa</Text>
        </View>

        <TextInput
          style={styles.search}
          placeholder="Buscar cliente..."
          placeholderTextColor={colors.textMuted}
          value={clientSearch}
          onChangeText={setClientSearch}
        />
        <Button label="+ Crear cliente rápido" variant="outline" onPress={() => navigation.navigate("NuevoCliente", { returnToPreventa: true })} style={{ marginHorizontal: spacing.lg, marginBottom: spacing.md }} />

        <FlatList
          data={clients}
          keyExtractor={(c) => c.id}
          contentContainerStyle={{ padding: spacing.lg, paddingTop: 0 }}
          ListEmptyComponent={<EmptyState message="No se encontraron clientes." />}
          renderItem={({ item }) => (
            <Pressable onPress={() => { setSelectedClient(item); setStep("products"); }}>
              <Card style={{ marginBottom: spacing.sm }}>
                <Text style={styles.clientName}>{item.business_name}</Text>
                {!!item.contact_name && <Text style={styles.clientSub}>{item.contact_name}</Text>}
              </Card>
            </Pressable>
          )}
        />
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <View style={styles.stepHeader}>
        <Text style={styles.stepTitle}>Paso 2: Productos</Text>
        <Pressable onPress={() => setStep("client")}>
          <Text style={styles.changeClient}>Cliente: {selectedClient?.business_name} · Cambiar</Text>
        </Pressable>
      </View>

      <TextInput
        style={styles.search}
        placeholder="Buscar producto por nombre o SKU"
        placeholderTextColor={colors.textMuted}
        value={productSearch}
        onChangeText={setProductSearch}
      />

      <ScrollView style={{ flex: 1 }}>
        <View style={{ paddingHorizontal: spacing.lg }}>
          {products.map((product) => (
            <ProductPicker key={product.id} product={product} onAdd={addToCart} />
          ))}
        </View>
      </ScrollView>

      {cart.length > 0 && (
        <Card style={styles.cartSummary}>
          <Text style={styles.cartTitle}>Pedido ({totals.itemCount} items)</Text>
          {cart.map((line) => (
            <View key={line.presentationId} style={styles.cartLine}>
              <View style={{ flex: 1 }}>
                <Text style={styles.cartLineName}>{line.productName}</Text>
                <Text style={styles.cartLineSub}>{line.presentationName} · Contiene {line.unitEquivalence} unidad{line.unitEquivalence === 1 ? "" : "es"} · {centsToBs(line.unitPriceCents)}</Text>
              </View>
              <Pressable onPress={() => changeQuantity(line.presentationId, -1)} style={styles.qtyBtn}><Text>-</Text></Pressable>
              <Text style={styles.qtyText}>{line.quantity}</Text>
              <Pressable onPress={() => changeQuantity(line.presentationId, 1)} style={styles.qtyBtn}><Text>+</Text></Pressable>
              <Text style={styles.lineSubtotal}>{centsToBs(line.subtotalCents)}</Text>
            </View>
          ))}

          <View style={styles.totalsBlock}>
            <TotalRow label="Subtotal bruto" value={centsToBs(totals.subtotalCents)} />
            <TotalRow label="Total" value={centsToBs(totals.totalCents)} bold />
          </View>

          {error && <Text style={styles.error}>{error}</Text>}
          <Button label={editingOrderId ? "GUARDAR CAMBIOS" : "GUARDAR PREVENTA"} onPress={handleSaveOrder} loading={saving} style={{ marginTop: spacing.md }} />
        </Card>
      )}
    </View>
  );
}

function ProductPicker({ product, onAdd }: { product: ProductWithPresentations; onAdd: (p: Product, pres: Presentation, qty: number) => void }) {
  const [selectedPres, setSelectedPres] = useState<Presentation | null>(product.presentations[0] || null);
  const [qty, setQty] = useState("1");

  if (product.presentations.length === 0) return null;

  return (
    <Card style={{ marginBottom: spacing.sm }}>
      <Text style={styles.pickerName}>{product.name}</Text>
      <Text style={styles.pickerSku}>SKU: {product.sku}</Text>
      <View style={styles.presChoices}>
        {product.presentations.map((p) => (
          <Pressable
            key={p.id}
            onPress={() => setSelectedPres(p)}
            style={[styles.presChoice, selectedPres?.id === p.id && styles.presChoiceActive]}
          >
            <Text style={[styles.presChoiceText, selectedPres?.id === p.id && { color: "#fff" }]}>{p.name}</Text>
            <Text style={[styles.presChoicePrice, selectedPres?.id === p.id && { color: "#fff" }]}>{centsToBs(p.price_cents)}</Text>
            <Text style={[styles.presChoicePrice, selectedPres?.id === p.id && { color: "#fff" }]}>Contiene {p.unit_equivalence} unidad{p.unit_equivalence === 1 ? "" : "es"}</Text>
          </Pressable>
        ))}
      </View>
      <View style={styles.addRow}>
        <TextInput style={styles.qtyInput} value={qty} onChangeText={setQty} keyboardType="number-pad" />
        <Button
          label="Agregar"
          onPress={() => {
            const n = parseInt(qty, 10);
            if (selectedPres && n > 0) onAdd(product, selectedPres, n);
          }}
          style={{ flex: 1, marginLeft: spacing.sm }}
        />
      </View>
    </Card>
  );
}

function TotalRow({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <View style={styles.totalRow}>
      <Text style={[styles.totalLabel, bold && { fontWeight: "700", color: colors.textPrimary }]}>{label}</Text>
      <Text style={[styles.totalValue, bold && { fontWeight: "700", fontSize: 16 }]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  stepHeader: { padding: spacing.lg, paddingBottom: spacing.sm },
  stepTitle: { fontSize: 18, fontWeight: "700", color: colors.textPrimary },
  stepSub: { fontSize: 13, color: colors.textSecondary, marginTop: 2 },
  changeClient: { fontSize: 13, color: colors.emeraldDark, fontWeight: "600", marginTop: 4 },
  search: {
    marginHorizontal: spacing.lg,
    marginBottom: spacing.md,
    minHeight: touchTarget.min,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
    backgroundColor: colors.surface,
  },
  clientName: { fontSize: 15, fontWeight: "700", color: colors.textPrimary },
  clientSub: { fontSize: 13, color: colors.textSecondary, marginTop: 2 },
  pickerName: { fontSize: 15, fontWeight: "700", color: colors.textPrimary },
  pickerSku: { fontSize: 12, color: colors.textMuted, marginTop: 2, marginBottom: spacing.sm },
  presChoices: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  presChoice: { borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, paddingHorizontal: 10, paddingVertical: 6, alignItems: "center" },
  presChoiceActive: { backgroundColor: colors.emerald, borderColor: colors.emerald },
  presChoiceText: { fontSize: 12, fontWeight: "600", color: colors.textPrimary },
  presChoicePrice: { fontSize: 11, color: colors.textSecondary },
  addRow: { flexDirection: "row", marginTop: spacing.md, alignItems: "center" },
  qtyInput: { width: 56, minHeight: touchTarget.min, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, textAlign: "center", backgroundColor: colors.surface },
  cartSummary: { margin: spacing.lg, marginTop: 0 },
  cartTitle: { fontWeight: "700", color: colors.textPrimary, marginBottom: spacing.sm },
  cartLine: { flexDirection: "row", alignItems: "center", marginBottom: spacing.sm },
  cartLineName: { fontSize: 13, fontWeight: "600", color: colors.textPrimary },
  cartLineSub: { fontSize: 11, color: colors.textMuted },
  qtyBtn: { width: 28, height: 28, borderRadius: 14, backgroundColor: colors.surfaceAlt, alignItems: "center", justifyContent: "center" },
  qtyText: { width: 24, textAlign: "center", fontWeight: "600" },
  lineSubtotal: { width: 70, textAlign: "right", fontWeight: "700", color: colors.emeraldDark, fontSize: 12 },
  totalsBlock: { borderTopWidth: 1, borderTopColor: colors.surfaceAlt3, marginTop: spacing.sm, paddingTop: spacing.sm },
  totalRow: { flexDirection: "row", justifyContent: "space-between", marginBottom: 4 },
  totalLabel: { fontSize: 12, color: colors.textSecondary },
  totalValue: { fontSize: 12, color: colors.textPrimary },
  error: { color: colors.errorText, marginTop: spacing.sm },
});
