import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { View, Text, TextInput, FlatList, ScrollView, StyleSheet, Pressable, Alert, Modal } from "react-native";
import { useFocusEffect, useIsFocused, useNavigation, useRoute } from "@react-navigation/native";
import { colors, spacing, radius, touchTarget } from "../theme/tokens";
import { Card } from "../components/Card";
import { Button } from "../components/Button";
import { EmptyState } from "../components/EmptyState";
import { ComboSelectorModal } from "../components/ComboSelectorModal";
import { getClient, listActiveClients } from "../db/repositories/clients";
import {
  listProducts,
  listFrequentProducts,
  listRecentProductsForClient,
  toggleFavoriteLocal,
  ProductWithPresentations,
} from "../db/repositories/products";
import { listCategories } from "../db/repositories/categories";
import { createOrderLocal, getOrderWithItems, updateOrderLocal } from "../db/repositories/orders";
import { getTodayWorkDay, reopenWorkDayLocal, resolveServerWorkDayId, upsertServerWorkDay } from "../db/repositories/workdays";
import { buildCartLine, calcOrderTotals, recalcLineQuantity, PricingError } from "../domain/pricing";
import { centsToBs } from "../domain/pricing";
import { CartLine, CartLineSelection, Category, Client, Presentation, Product, WorkDay } from "../domain/types";
import { useAuth } from "../context/AuthContext";
import { useSync } from "../context/SyncContext";
import { apiFetch, ApiError } from "../services/api";
import { useDebounce } from "../utils/useDebounce";

type Step = "client" | "products";
type ProductFilterMode = "all" | "favorites" | "recent" | "frequent" | "category";
const clientKeyExtractor = (client: Client) => client.id;
const productKeyExtractor = (product: ProductWithPresentations) => product.id;

export function NewSaleScreen() {
  const navigation = useNavigation<any>();
  const route = useRoute<any>();
  const isFocused = useIsFocused();
  const { user } = useAuth();
  const { forceSync, pushSync } = useSync();

  const [workDay, setWorkDay] = useState<WorkDay | null>(null);
  const [step, setStep] = useState<Step>("client");
  const [clientSearch, setClientSearch] = useState("");
  const debouncedClientSearch = useDebounce(clientSearch, 300);
  const [clients, setClients] = useState<Client[]>([]);
  const [selectedClient, setSelectedClient] = useState<Client | null>(null);

  const [productSearch, setProductSearch] = useState("");
  const debouncedProductSearch = useDebounce(productSearch, 300);
  const [products, setProducts] = useState<ProductWithPresentations[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [recentCount, setRecentCount] = useState(0);

  // Filtros rápidos
  const [filterMode, setFilterMode] = useState<ProductFilterMode>("all");
  const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(null);

  const [cart, setCart] = useState<CartLine[]>([]);
  const [paymentCondition] = useState("Contado 48h");
  const [saving, setSaving] = useState(false);
  const saveInFlightRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const editingOrderId = route.params?.orderId as string | undefined;

  // Estado para modal de revisión de pedido/carrito sin scrollear
  const [cartModalVisible, setCartModalVisible] = useState(false);

  // Estado para modal de selección de combo
  const [comboModalVisible, setComboModalVisible] = useState(false);
  const [comboModalProduct, setComboModalProduct] = useState<ProductWithPresentations | null>(null);
  const [comboModalPresentation, setComboModalPresentation] = useState<Presentation | null>(null);

  const checkWorkDay = useCallback(async () => {
    if (!user) return;
    const wd = await getTodayWorkDay(user.id);
    setWorkDay(wd);
  }, [user]);

  const loadClients = useCallback(async () => {
    setClients(await listActiveClients(debouncedClientSearch));
  }, [debouncedClientSearch]);

  const productSearchForMode = filterMode === "recent" || filterMode === "frequent"
    ? ""
    : debouncedProductSearch;

  const loadProducts = useCallback(async () => {
    if (filterMode === "recent" && selectedClient) {
      const recents = await listRecentProductsForClient(selectedClient.id);
      setProducts(recents);
      return;
    }
    if (filterMode === "frequent") {
      const frequents = await listFrequentProducts(15);
      setProducts(frequents);
      return;
    }

    const [prods, cats] = await Promise.all([
      listProducts({
        search: productSearchForMode,
        categoryId: filterMode === "category" ? selectedCategoryId : undefined,
        onlyFavorites: filterMode === "favorites" ? true : undefined,
      }),
      listCategories(),
    ]);
    setProducts(prods);
    setCategories(cats);
  }, [productSearchForMode, filterMode, selectedCategoryId, selectedClient]);

  // Cargar contador de compras recientes del cliente seleccionado
  useEffect(() => {
    if (selectedClient) {
      listRecentProductsForClient(selectedClient.id).then((rec) => {
        setRecentCount(rec.length);
      });
    } else {
      setRecentCount(0);
    }
  }, [selectedClient]);

  useFocusEffect(
    useCallback(() => {
      void checkWorkDay();
    }, [checkWorkDay])
  );

  useEffect(() => {
    if (isFocused) void loadClients();
  }, [isFocused, loadClients]);

  useEffect(() => {
    if (isFocused) void loadProducts();
  }, [isFocused, loadProducts]);

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

  // Al editar, reconstruye el carrito usando el snapshot de la preventa incluyendo combos.
  useEffect(() => {
    if (!editingOrderId) return;
    getOrderWithItems(editingOrderId).then(async ({ order, items }) => {
      if (!order) return;
      const client = await getClient(order.client_id);
      if (client) setSelectedClient(client);
      setCart(items.map((item: any) => ({
        productId: item.product_id,
        presentationId: item.presentation_id,
        productName: item.product_name_snapshot,
        sku: item.sku_snapshot,
        presentationName: item.presentation_name_snapshot,
        unitEquivalence: item.unit_equivalence_snapshot,
        unitPriceCents: item.unit_price_cents_snapshot,
        quantity: item.quantity,
        subtotalCents: item.subtotal_cents,
        isCombo: item.selections && item.selections.length > 0,
        selections: (item.selections || []).map((s: any) => ({
          selectedProductId: s.selected_product_id,
          selectedPresentationId: s.selected_presentation_id,
          productNameSnapshot: s.product_name_snapshot,
          presentationNameSnapshot: s.presentation_name_snapshot,
          quantity: s.quantity,
          sortOrder: s.sort_order,
        })),
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

  const addToCart = useCallback((product: Product, presentation: Presentation, quantity: number) => {
    try {
      setCart((prev) => {
        const existingIdx = prev.findIndex((l) => l.presentationId === presentation.id && !l.isCombo);
        if (existingIdx >= 0) {
          const updated = recalcLineQuantity(prev[existingIdx], prev[existingIdx].quantity + quantity);
          return prev.map((l, i) => (i === existingIdx ? updated : l));
        } else {
          const line = buildCartLine(product, presentation, quantity);
          return [...prev, line];
        }
      });
    } catch (err) {
      if (err instanceof PricingError) Alert.alert("No se pudo agregar", err.message);
    }
  }, []);

  const handleOpenComboModal = useCallback((product: ProductWithPresentations, presentation: Presentation) => {
    if (!product.combo_definition || !product.combo_definition.options?.length) {
      Alert.alert("Combo incompleto", "Este combo no tiene opciones configuradas.");
      return;
    }
    setComboModalProduct(product);
    setComboModalPresentation(presentation);
    setComboModalVisible(true);
  }, []);

  const handleAddComboToCart = useCallback(
    (
      product: ProductWithPresentations,
      presentation: Presentation,
      quantity: number,
      selections: CartLineSelection[]
    ) => {
      const line: CartLine = {
        ...buildCartLine(product, presentation, quantity),
        isCombo: true,
        selections,
      };
      setCart((prev) => [...prev, line]);
    },
    []
  );

  const handleCloseComboModal = useCallback(() => {
    setComboModalVisible(false);
    setComboModalProduct(null);
    setComboModalPresentation(null);
  }, []);

  const changeLineQuantity = useCallback((index: number, delta: number) => {
    setCart((prev) =>
      prev
        .map((line, i) => {
          if (i !== index) return line;
          const quantity = line.quantity + delta;
          return quantity > 0 ? recalcLineQuantity(line, quantity) : null;
        })
        .filter((line): line is CartLine => line !== null)
    );
  }, []);

  const handleToggleFavorite = useCallback(async (productId: string) => {
    const nowFav = await toggleFavoriteLocal(productId);
    setProducts((prev) =>
      prev.map((p) => (p.id === productId ? { ...p, is_favorite: nowFav } : p))
    );
  }, []);

  const handleSelectClient = useCallback((client: Client) => {
    setSelectedClient(client);
    setStep("products");
  }, []);

  async function handleSaveOrder() {
    if (saveInFlightRef.current) return;
    setError(null);
    if (!selectedClient) {
      setError("Selecciona un cliente antes de guardar.");
      return;
    }
    if (cart.length === 0) {
      setError("Agrega al menos un producto.");
      return;
    }
    saveInFlightRef.current = true;
    setSaving(true);
    try {
      let currentWd = await getTodayWorkDay(user!.id);
      const localWdId = currentWd.id;

      try {
        const freshRes = await apiFetch<any>("/workdays/current?fresh=1");
        if (freshRes?.workDay) {
          await upsertServerWorkDay(localWdId, freshRes.workDay);
          currentWd = {
            ...currentWd,
            ...freshRes.workDay,
            id: localWdId,
            server_id: freshRes.workDay.id,
            status: freshRes.workDay.status,
          };
          setWorkDay(currentWd);
        }
      } catch (netErr) {
        if (netErr instanceof ApiError && netErr.status >= 400 && netErr.status < 500) {
          throw netErr;
        }
        console.warn("No se pudo verificar estado online de jornada, usando local:", netErr);
      }

      if (currentWd.status === "closed") {
        setError("La jornada de hoy ya fue concluida. Debes reabrir la jornada para registrar preventas.");
        Alert.alert(
          "Jornada Concluida",
          "La jornada de hoy ya fue cerrada por otro usuario. No es posible registrar pedidos en una jornada concluida. Para añadir nuevas preventas debes reabrir la jornada.",
          [
            { text: "Entendido", style: "cancel" },
            { text: "Reabrir Jornada", onPress: handleReopen },
          ]
        );
        return;
      }

      if (editingOrderId) {
        await updateOrderLocal(editingOrderId, cart, paymentCondition);
      } else {
        await createOrderLocal({
          workDayLocalId: localWdId,
          clientId: selectedClient.id,
          paymentCondition,
          lines: cart,
        });
      }
      await pushSync();
      setCart([]);
      setSelectedClient(null);
      setCartModalVisible(false);
      setStep("client");
      Alert.alert(editingOrderId ? "Preventa actualizada" : "Preventa guardada", "Se sincronizará automáticamente.");
      if (editingOrderId) navigation.goBack();
      else navigation.navigate("Registros");
    } catch (err: any) {
      setError(err.message || "No se pudo guardar la preventa.");
    } finally {
      saveInFlightRef.current = false;
      setSaving(false);
    }
  }

  const favoriteCount = useMemo(() => products.filter((p) => p.is_favorite).length, [products]);

  const renderProductItem = useCallback(
    ({ item }: { item: ProductWithPresentations }) => (
      <ProductPickerItem
        product={item}
        onAdd={addToCart}
        onConfigureCombo={handleOpenComboModal}
        onToggleFavorite={handleToggleFavorite}
      />
    ),
    [addToCart, handleOpenComboModal, handleToggleFavorite]
  );

  const renderClientItem = useCallback(
    ({ item }: { item: Client }) => (
      <ClientPickerItem client={item} onSelect={handleSelectClient} />
    ),
    [handleSelectClient]
  );

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
        <Button
          label="+ Crear cliente rápido"
          variant="outline"
          onPress={() => navigation.navigate("NuevoCliente", { returnToPreventa: true })}
          style={{ marginHorizontal: spacing.lg, marginBottom: spacing.md }}
        />

        <FlatList
          data={clients}
          keyExtractor={clientKeyExtractor}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ padding: spacing.lg, paddingTop: 0 }}
          ListEmptyComponent={<EmptyState message="No se encontraron clientes." />}
          renderItem={renderClientItem}
          initialNumToRender={10}
          maxToRenderPerBatch={10}
          windowSize={5}
          removeClippedSubviews={true}
        />
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <View style={styles.stepHeader}>
        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
          <Text style={styles.stepTitle}>Paso 2: Productos</Text>
          {cart.length > 0 && (
            <Pressable style={styles.headerCartBadge} onPress={() => setCartModalVisible(true)}>
              <Text style={styles.headerCartBadgeText}>🛒 {totals.itemCount} ({centsToBs(totals.totalCents)})</Text>
            </Pressable>
          )}
        </View>
        <Pressable onPress={() => setStep("client")}>
          <Text style={styles.changeClient}>Cliente: {selectedClient?.business_name} · Cambiar</Text>
        </Pressable>
      </View>

      <View style={styles.topFilterSection}>
        <TextInput
          style={styles.search}
          placeholder="Buscar producto por nombre o SKU..."
          placeholderTextColor={colors.textMuted}
          value={productSearch}
          onChangeText={setProductSearch}
        />

        {/* Barra de atajos rápidos y categorías con altura fija y sin distorsión */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.filterChipsRow}
        >
          <Pressable
            style={[
              styles.filterChip,
              filterMode === "all" && styles.filterChipActive,
            ]}
            onPress={() => {
              setFilterMode("all");
              setSelectedCategoryId(null);
            }}
          >
            <Text style={[styles.filterChipText, filterMode === "all" && styles.filterChipTextActive]}>
              Todos
            </Text>
          </Pressable>

          <Pressable
            style={[
              styles.filterChip,
              filterMode === "favorites" && styles.filterChipFavActive,
            ]}
            onPress={() => {
              setFilterMode("favorites");
              setSelectedCategoryId(null);
            }}
          >
            <Text style={[styles.filterChipText, filterMode === "favorites" && styles.filterChipTextActive]}>
              ⭐ Favoritos ({favoriteCount})
            </Text>
          </Pressable>

          {recentCount > 0 && (
            <Pressable
              style={[
                styles.filterChip,
                filterMode === "recent" && styles.filterChipActive,
              ]}
              onPress={() => {
                setFilterMode("recent");
                setSelectedCategoryId(null);
              }}
            >
              <Text style={[styles.filterChipText, filterMode === "recent" && styles.filterChipTextActive]}>
                🕒 Comprados antes ({recentCount})
              </Text>
            </Pressable>
          )}

          <Pressable
            style={[
              styles.filterChip,
              filterMode === "frequent" && styles.filterChipActive,
            ]}
            onPress={() => {
              setFilterMode("frequent");
              setSelectedCategoryId(null);
            }}
          >
            <Text style={[styles.filterChipText, filterMode === "frequent" && styles.filterChipTextActive]}>
              🔥 Más vendidos
            </Text>
          </Pressable>

          {categories.map((c) => {
            const isActive = filterMode === "category" && selectedCategoryId === c.id;
            return (
              <Pressable
                key={c.id}
                style={[
                  styles.filterChip,
                  isActive && styles.filterChipActive,
                ]}
                onPress={() => {
                  setFilterMode("category");
                  setSelectedCategoryId(c.id);
                }}
              >
                <Text style={[styles.filterChipText, isActive && styles.filterChipTextActive]}>
                  📁 {c.name}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>
      </View>

      <FlatList
        data={products}
        keyExtractor={productKeyExtractor}
        keyboardShouldPersistTaps="handled"
        renderItem={renderProductItem}
        contentContainerStyle={{ padding: spacing.lg, paddingTop: spacing.xs, paddingBottom: cart.length > 0 ? 100 : spacing.lg }}
        initialNumToRender={6}
        maxToRenderPerBatch={8}
        windowSize={5}
        removeClippedSubviews={true}
        ListEmptyComponent={<EmptyState message="No hay productos disponibles para este filtro." />}
        ListFooterComponent={
          cart.length > 0 ? (
            <Card style={styles.cartSummary}>
              <Text style={styles.cartTitle}>Pedido ({totals.itemCount} items)</Text>
              {cart.map((line, idx) => (
                <CartLineItemRow
                  key={`${line.presentationId}-${idx}`}
                  line={line}
                  index={idx}
                  onChangeQty={changeLineQuantity}
                />
              ))}

              <View style={styles.totalsBlock}>
                <TotalRow label="Subtotal bruto" value={centsToBs(totals.subtotalCents)} />
                <TotalRow label="Total" value={centsToBs(totals.totalCents)} bold />
              </View>

              {error && <Text style={styles.error}>{error}</Text>}
              <Button
                label={editingOrderId ? "GUARDAR CAMBIOS" : "GUARDAR PREVENTA"}
                onPress={handleSaveOrder}
                loading={saving}
                disabled={saving}
                style={{ marginTop: spacing.md }}
              />
            </Card>
          ) : null
        }
      />

      {/* Barra fija inferior cuando hay productos en el carrito */}
      {cart.length > 0 && (
        <View style={styles.dockedBottomBar}>
          <Pressable style={styles.dockedCartInfo} onPress={() => setCartModalVisible(true)}>
            <View style={styles.dockedCartIconWrap}>
              <Text style={{ fontSize: 20 }}>🛒</Text>
              <View style={styles.dockedCartBadgeCircle}>
                <Text style={styles.dockedCartBadgeText}>{totals.itemCount}</Text>
              </View>
            </View>
            <View style={{ marginLeft: 10 }}>
              <Text style={styles.dockedTotalText}>{centsToBs(totals.totalCents)}</Text>
              <Text style={styles.dockedSubtitle}>Toca para revisar items ({totals.itemCount})</Text>
            </View>
          </Pressable>
          <Button
            label={editingOrderId ? "Revisar / Guardar" : "Ver Pedido"}
            variant="primary"
            onPress={() => setCartModalVisible(true)}
            style={styles.dockedViewBtn}
          />
        </View>
      )}

      {/* Modal para revisar el pedido y guardar sin necesidad de scrollear al fondo del catálogo */}
      <Modal
        visible={cartModalVisible}
        animationType="slide"
        transparent={true}
        onRequestClose={() => setCartModalVisible(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <View style={styles.modalHeaderRow}>
              <View style={{ flex: 1, marginRight: spacing.sm }}>
                <Text style={styles.modalTitle}>Resumen del Pedido</Text>
                <Text style={styles.modalClientSub}>Cliente: {selectedClient?.business_name}</Text>
              </View>
              <Pressable onPress={() => setCartModalVisible(false)} style={styles.modalCloseBtn}>
                <Text style={styles.modalCloseBtnText}>✕ Seguir agregando</Text>
              </Pressable>
            </View>

            <ScrollView style={styles.modalScroll} keyboardShouldPersistTaps="handled">
              <Text style={styles.cartTitle}>Productos añadidos ({totals.itemCount} items)</Text>
              {cart.map((line, idx) => (
                <CartLineItemRow
                  key={`${line.presentationId}-${idx}`}
                  line={line}
                  index={idx}
                  onChangeQty={changeLineQuantity}
                />
              ))}

              <View style={styles.totalsBlock}>
                <TotalRow label="Subtotal bruto" value={centsToBs(totals.subtotalCents)} />
                <TotalRow label="Total" value={centsToBs(totals.totalCents)} bold />
              </View>

              {error && <Text style={styles.error}>{error}</Text>}
            </ScrollView>

            <View style={styles.modalFooter}>
              <Button
                label={editingOrderId ? "GUARDAR CAMBIOS" : "GUARDAR PREVENTA"}
                onPress={handleSaveOrder}
                loading={saving}
                disabled={saving}
              />
              <Button
                label="Volver al catálogo"
                variant="outline"
                onPress={() => setCartModalVisible(false)}
                style={{ marginTop: spacing.sm }}
              />
            </View>
          </View>
        </View>
      </Modal>

      <ComboSelectorModal
        visible={comboModalVisible}
        product={comboModalProduct}
        presentation={comboModalPresentation}
        onAdd={handleAddComboToCart}
        onClose={handleCloseComboModal}
      />
    </View>
  );
}

const ClientPickerItem = React.memo(function ClientPickerItem({
  client,
  onSelect,
}: {
  client: Client;
  onSelect: (client: Client) => void;
}) {
  return (
    <Pressable onPress={() => onSelect(client)}>
      <Card style={{ marginBottom: spacing.sm }}>
        <Text style={styles.clientName}>{client.business_name}</Text>
        {!!client.contact_name && <Text style={styles.clientSub}>{client.contact_name}</Text>}
      </Card>
    </Pressable>
  );
});

const CartLineItemRow = React.memo(function CartLineItemRow({
  line,
  index,
  onChangeQty,
}: {
  line: CartLine;
  index: number;
  onChangeQty: (idx: number, delta: number) => void;
}) {
  return (
    <View style={styles.cartLine}>
      <View style={{ flex: 1, marginRight: spacing.xs }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
          <Text style={styles.cartLineName}>{line.productName}</Text>
          {line.isCombo && (
            <View style={styles.miniComboBadge}>
              <Text style={styles.miniComboText}>🎁 Combo</Text>
            </View>
          )}
        </View>
        <Text style={styles.cartLineSub}>
          {line.presentationName} · Contiene {line.unitEquivalence} unidad{line.unitEquivalence === 1 ? "" : "es"} · {centsToBs(line.unitPriceCents)}
        </Text>
        {line.selections && line.selections.length > 0 && (
          <View style={styles.cartSelectionsWrap}>
            {line.selections.map((sel, sIdx) => (
              <Text key={sIdx} style={styles.cartSelectionItem}>
                • {sel.quantity} × {sel.productNameSnapshot} ({sel.presentationNameSnapshot})
              </Text>
            ))}
          </View>
        )}
      </View>
      <Pressable onPress={() => onChangeQty(index, -1)} style={styles.qtyBtn}><Text>-</Text></Pressable>
      <Text style={styles.qtyText}>{line.quantity}</Text>
      <Pressable onPress={() => onChangeQty(index, 1)} style={styles.qtyBtn}><Text>+</Text></Pressable>
      <Text style={styles.lineSubtotal}>{centsToBs(line.subtotalCents)}</Text>
    </View>
  );
});

const ProductPickerItem = React.memo(function ProductPickerItem({
  product,
  onAdd,
  onConfigureCombo,
  onToggleFavorite,
}: {
  product: ProductWithPresentations;
  onAdd: (p: Product, pres: Presentation, qty: number) => void;
  onConfigureCombo: (p: ProductWithPresentations, pres: Presentation) => void;
  onToggleFavorite: (id: string) => void;
}) {
  const [selectedPres, setSelectedPres] = useState<Presentation | null>(product.presentations[0] || null);
  const [qty, setQty] = useState("1");
  const isCombo = product.product_type === "combo";

  useEffect(() => {
    setSelectedPres(product.presentations[0] || null);
    setQty("1");
  }, [product.id]);

  if (product.presentations.length === 0) return null;

  return (
    <Card style={{ marginBottom: spacing.sm }}>
      <View style={styles.pickerHeader}>
        <View style={{ flexDirection: "row", alignItems: "center", flex: 1, marginRight: spacing.xs }}>
          <Text style={styles.pickerName}>{product.name}</Text>
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <Pressable onPress={() => onToggleFavorite(product.id)} style={styles.starBtn}>
            <Text style={{ fontSize: 18 }}>{product.is_favorite ? "⭐" : "☆"}</Text>
          </Pressable>
          {isCombo && (
            <View style={styles.miniComboBadge}>
              <Text style={styles.miniComboText}>🎁 Combo</Text>
            </View>
          )}
        </View>
      </View>
      <Text style={styles.pickerSku}>SKU: {product.sku}</Text>
      <View style={styles.presChoices}>
        {product.presentations.map((p) => (
          <Pressable
            key={p.id}
            onPress={() => {
              setSelectedPres(p);
              setQty("1");
            }}
            style={[styles.presChoice, selectedPres?.id === p.id && styles.presChoiceActive]}
          >
            <Text style={[styles.presChoiceText, selectedPres?.id === p.id && { color: "#fff" }]}>{p.name}</Text>
            <Text style={[styles.presChoicePrice, selectedPres?.id === p.id && { color: "#fff" }]}>{centsToBs(p.price_cents)}</Text>
            <Text style={[styles.presChoicePrice, selectedPres?.id === p.id && { color: "#fff" }]}>Contiene {p.unit_equivalence} unidad{p.unit_equivalence === 1 ? "" : "es"}</Text>
          </Pressable>
        ))}
      </View>

      {isCombo ? (
        <View style={styles.comboActionRow}>
          <Button
            label="🎁 Configurar opciones del combo"
            onPress={() => {
              if (selectedPres) onConfigureCombo(product, selectedPres);
            }}
            style={{ flex: 1 }}
          />
        </View>
      ) : (
        <View style={styles.addRow}>
          <TextInput
            style={styles.qtyInput}
            value={qty}
            onChangeText={setQty}
            keyboardType="number-pad"
            maxLength={4}
          />
          <Button
            label="Agregar"
            onPress={() => {
              const n = parseInt(qty, 10);
              if (selectedPres && n > 0) {
                onAdd(product, selectedPres, n);
                setQty("1");
              }
            }}
            style={{ flex: 1, marginLeft: spacing.sm }}
          />
        </View>
      )}
    </Card>
  );
});

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
    marginBottom: spacing.xs,
    minHeight: touchTarget.min,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
    backgroundColor: colors.surface,
  },
  topFilterSection: {
    paddingBottom: spacing.xs,
  },
  filterChipsRow: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.xs,
    alignItems: "center",
    flexDirection: "row",
  },
  filterChip: {
    height: 32,
    paddingHorizontal: 12,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.border,
    marginRight: spacing.xs,
    justifyContent: "center",
    alignItems: "center",
  },
  filterChipActive: {
    backgroundColor: colors.navy,
    borderColor: colors.navy,
  },
  filterChipFavActive: {
    backgroundColor: "#b45309",
    borderColor: "#b45309",
  },
  filterChipText: {
    fontSize: 12,
    fontWeight: "600",
    color: colors.textSecondary,
    lineHeight: 16,
  },
  filterChipTextActive: {
    color: "#fff",
  },
  clientName: { fontSize: 15, fontWeight: "700", color: colors.textPrimary },
  clientSub: { fontSize: 13, color: colors.textSecondary, marginTop: 2 },
  pickerHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  pickerName: { fontSize: 15, fontWeight: "700", color: colors.textPrimary },
  pickerSku: { fontSize: 12, color: colors.textMuted, marginTop: 2, marginBottom: spacing.sm },
  starBtn: { padding: 2 },
  miniComboBadge: {
    backgroundColor: "#ede9fe",
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: radius.pill,
  },
  miniComboText: {
    fontSize: 10,
    fontWeight: "700",
    color: "#6d28d9",
  },
  presChoices: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  presChoice: { borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, paddingHorizontal: 10, paddingVertical: 6, alignItems: "center" },
  presChoiceActive: { backgroundColor: colors.emerald, borderColor: colors.emerald },
  presChoiceText: { fontSize: 12, fontWeight: "600", color: colors.textPrimary },
  presChoicePrice: { fontSize: 11, color: colors.textSecondary },
  addRow: { flexDirection: "row", marginTop: spacing.md, alignItems: "center" },
  comboActionRow: { marginTop: spacing.md },
  qtyInput: { width: 56, minHeight: touchTarget.min, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, textAlign: "center", backgroundColor: colors.surface },
  cartSummary: { marginTop: spacing.md, marginBottom: spacing.lg },
  cartTitle: { fontWeight: "700", color: colors.textPrimary, marginBottom: spacing.sm },
  cartLine: { flexDirection: "row", alignItems: "flex-start", marginBottom: spacing.sm, borderBottomWidth: 1, borderBottomColor: colors.surfaceAlt3, paddingBottom: spacing.xs },
  cartLineName: { fontSize: 13, fontWeight: "600", color: colors.textPrimary },
  cartLineSub: { fontSize: 11, color: colors.textMuted, marginTop: 1 },
  cartSelectionsWrap: {
    backgroundColor: colors.surfaceAlt,
    padding: 6,
    borderRadius: radius.sm,
    marginTop: 4,
  },
  cartSelectionItem: {
    fontSize: 11,
    color: colors.textSecondary,
    lineHeight: 15,
  },
  qtyBtn: { width: 28, height: 28, borderRadius: 14, backgroundColor: colors.surfaceAlt, alignItems: "center", justifyContent: "center", marginTop: 2 },
  qtyText: { width: 24, textAlign: "center", fontWeight: "600", marginTop: 6 },
  lineSubtotal: { width: 70, textAlign: "right", fontWeight: "700", color: colors.emeraldDark, fontSize: 12, marginTop: 6 },
  totalsBlock: { borderTopWidth: 1, borderTopColor: colors.surfaceAlt3, marginTop: spacing.sm, paddingTop: spacing.sm },
  totalRow: { flexDirection: "row", justifyContent: "space-between", marginBottom: 4 },
  totalLabel: { fontSize: 12, color: colors.textSecondary },
  totalValue: { fontSize: 12, color: colors.textPrimary },
  error: { color: colors.errorText, marginTop: spacing.sm },
  headerCartBadge: {
    backgroundColor: colors.emerald,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: radius.pill,
  },
  headerCartBadgeText: {
    color: "#fff",
    fontSize: 12,
    fontWeight: "700",
  },
  dockedBottomBar: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: colors.surface,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    elevation: 8,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: -2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
  },
  dockedCartInfo: {
    flexDirection: "row",
    alignItems: "center",
    flex: 1,
    marginRight: spacing.sm,
  },
  dockedCartIconWrap: {
    position: "relative",
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.surfaceAlt,
    alignItems: "center",
    justifyContent: "center",
  },
  dockedCartBadgeCircle: {
    position: "absolute",
    top: -4,
    right: -4,
    backgroundColor: colors.emerald,
    borderRadius: 9,
    minWidth: 18,
    height: 18,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 3,
  },
  dockedCartBadgeText: {
    color: "#fff",
    fontSize: 10,
    fontWeight: "700",
  },
  dockedTotalText: {
    fontSize: 15,
    fontWeight: "700",
    color: colors.textPrimary,
  },
  dockedSubtitle: {
    fontSize: 11,
    color: colors.textMuted,
  },
  dockedViewBtn: {
    minHeight: 40,
    paddingHorizontal: 16,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.5)",
    justifyContent: "flex-end",
  },
  modalCard: {
    backgroundColor: colors.bg,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    maxHeight: "85%",
    padding: spacing.lg,
  },
  modalHeaderRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    paddingBottom: spacing.sm,
    marginBottom: spacing.md,
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: "700",
    color: colors.textPrimary,
  },
  modalClientSub: {
    fontSize: 13,
    color: colors.emeraldDark,
    fontWeight: "600",
    marginTop: 2,
  },
  modalCloseBtn: {
    paddingVertical: 5,
    paddingHorizontal: 10,
    borderRadius: radius.sm,
    backgroundColor: colors.surfaceAlt,
  },
  modalCloseBtnText: {
    fontSize: 12,
    fontWeight: "600",
    color: colors.textSecondary,
  },
  modalScroll: {
    maxHeight: 380,
  },
  modalFooter: {
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: spacing.md,
    marginTop: spacing.sm,
  },
});
