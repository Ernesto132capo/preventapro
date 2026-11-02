import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { View, Text, TextInput, FlatList, ScrollView, StyleSheet, Pressable, Alert, ActivityIndicator } from "react-native";
import { useFocusEffect, useIsFocused, useNavigation, useRoute } from "@react-navigation/native";
import { colors, spacing, radius, touchTarget } from "../theme/tokens";
import { Card } from "../components/Card";
import { Button } from "../components/Button";
import { EmptyState } from "../components/EmptyState";
import { ClientPickerItem, ProductPickerItem } from "../components/sale/SaleRows";
import { CartReviewModal, PriceReviewModal, FinalPriceConfirmModal, PriceDiffItem } from "../components/sale/SaleDialogs";
export type { PriceDiffItem } from "../components/sale/SaleDialogs";
import { ComboSelectorModal } from "../components/ComboSelectorModal";
import { getClient, listActiveClients } from "../db/repositories/clients";
import {
  listProducts,
  getPresentationsByIds,
  ProductWithPresentations,
} from "../db/repositories/products";
import { createOrderLocal, getOrderWithItems, updateOrderLocal } from "../db/repositories/orders";
import { getTodayWorkDay, reopenWorkDayLocal, resolveServerWorkDayId } from "../db/repositories/workdays";
import { buildCartLine, calcOrderTotals, recalcLineQuantity, updateLineUnitPrice, calcPriceDifference, PricingError } from "../domain/pricing";
import { centsToBs } from "../domain/pricing";
import { CartLine, CartLineSelection, Client, Presentation, Product, WorkDay } from "../domain/types";
import { formatClientDisplayName } from "../domain/client-display";
import { useAuth } from "../context/AuthContext";
import { useSync } from "../context/SyncContext";
import { apiFetch } from "../services/api";
import { ProductFilterMode, useSaleCatalog } from "../hooks/useSaleCatalog";
import { measurePerformance } from "../services/performance";
import { validateSaleDraft } from "../services/saleValidation";
import { captureComboCatalog, reviewSaleCatalog, saleDraftKey } from "../utils/saleReview";

type Step = "client" | "products";
const clientKeyExtractor = (client: Client) => client.id;
const productKeyExtractor = (product: ProductWithPresentations) => product.id;


export function NewSaleScreen() {
  const navigation = useNavigation<any>();
  const route = useRoute<any>();
  const isFocused = useIsFocused();
  const { user } = useAuth();
  const { forceSync, pushSync, catalogRevision, connection } = useSync();

  const editingOrderId = route.params?.orderId as string | undefined;
  const isEditing = Boolean(editingOrderId);

  const [workDay, setWorkDay] = useState<WorkDay | null>(null);
  const [step, setStep] = useState<Step>(isEditing ? "products" : "client");
  const [loadingOrder, setLoadingOrder] = useState(isEditing);
  const [clientSearch, setClientSearch] = useState("");
  const [selectedClient, setSelectedClient] = useState<Client | null>(null);

  const [productSearch, setProductSearch] = useState("");

  // Filtros rápidos
  const [filterMode, setFilterMode] = useState<ProductFilterMode>("all");
  const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(null);
  const { clients, setClients, products, categories, recentCount, handleToggleFavorite,
    loadingClients, loadingProducts, catalogError } = useSaleCatalog({
    isFocused, catalogRevision, clientSearch, productSearch, filterMode, selectedCategoryId, selectedClient,
  });

  const [cart, setCart] = useState<CartLine[]>([]);
  const cartRef = useRef(cart);
  const [paymentCondition] = useState("Contado 48h");
  const [saving, setSaving] = useState(false);
  const saveInFlightRef = useRef(false);
  const [error, setError] = useState<string | null>(null);

  // Estado para modal de revisión de pedido/carrito sin scrollear
  const [cartModalVisible, setCartModalVisible] = useState(false);

  // Estado para modal de selección de combo
  const [comboModalVisible, setComboModalVisible] = useState(false);
  const [comboModalProduct, setComboModalProduct] = useState<ProductWithPresentations | null>(null);
  const [comboModalPresentation, setComboModalPresentation] = useState<Presentation | null>(null);

  // Estado para selección de precios históricos vs actuales al editar preventa
  const [priceDifferences, setPriceDifferences] = useState<PriceDiffItem[]>([]);
  const [originalOrderTotalCents, setOriginalOrderTotalCents] = useState<number>(0);
  const [estimatedNewTotalCents, setEstimatedNewTotalCents] = useState<number>(0);
  const [priceDiffModalVisible, setPriceDiffModalVisible] = useState(false);
  const [priceDecision, setPriceDecision] = useState<"historical" | "current" | null>(null);
  const [currentPresMap, setCurrentPresMap] = useState<Map<string, Presentation>>(new Map());
  const [finalConfirmModalVisible, setFinalConfirmModalVisible] = useState(false);
  const draftKey = useMemo(() => saleDraftKey(selectedClient?.id || "", cart, editingOrderId), [selectedClient?.id, cart, editingOrderId]);
  const draftKeyRef = useRef(draftKey);
  const focusedRef = useRef(isFocused);
  const approvedCatalogRef = useRef<string | null>(null);
  draftKeyRef.current = draftKey;
  focusedRef.current = isFocused;
  cartRef.current = cart;

  const checkWorkDay = useCallback(async () => {
    if (!user) return;
    const wd = await getTodayWorkDay(user.id);
    setWorkDay(wd);
  }, [user]);

  useFocusEffect(
    useCallback(() => {
      focusedRef.current = true;
      void checkWorkDay();
      return () => { focusedRef.current = false; };
    }, [checkWorkDay])
  );

  useEffect(() => () => { focusedRef.current = false; }, []);

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
    if (isEditing || !route.params?.preselectedClientId) return;
    listActiveClients().then((all) => {
      const c = all.find((x) => x.id === route.params.preselectedClientId);
      if (c) {
        setSelectedClient(c);
        setStep("products");
      }
    });
  }, [isEditing, route.params?.preselectedClientId]);

  // Al editar, reconstruye el carrito usando el snapshot de la preventa incluyendo combos,
  // y compara cada línea con los precios vigentes del catálogo.
  useEffect(() => {
    if (!editingOrderId) return;
    setLoadingOrder(true);
    getOrderWithItems(editingOrderId)
      .then(async ({ order, items }) => {
        if (!order) {
          Alert.alert("Preventa no encontrada", "La preventa que intentas editar no existe.", [
            { text: "Volver", onPress: () => navigation.goBack() },
          ]);
          return;
        }
        const client = await getClient(order.client_id);
        if (!client) {
          Alert.alert("Cliente no encontrado", "No se encontró el cliente original de esta preventa.", [
            { text: "Volver", onPress: () => navigation.goBack() },
          ]);
          return;
        }
        setSelectedClient(client);

        const comboProductIds = [...new Set(items.filter((item: any) => item.selections?.length > 0).map((item: any) => String(item.product_id)))];
        const comboProducts = comboProductIds.length ? await listProducts({ productIds: comboProductIds }) : [];
        const comboDefinitions = new Map<string, ProductWithPresentations["combo_definition"]>();
        for (const product of comboProducts) {
          comboDefinitions.set(product.id, product.combo_definition);
          if (product.server_id) comboDefinitions.set(product.server_id, product.combo_definition);
        }

        const loadedCart: CartLine[] = items.map((item: any) => ({
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
          comboCatalogSnapshot: captureComboCatalog(comboDefinitions.get(item.product_id)),
          selections: (item.selections || []).map((s: any) => ({
            selectedProductId: s.selected_product_id,
            selectedPresentationId: s.selected_presentation_id,
            productNameSnapshot: s.product_name_snapshot,
            presentationNameSnapshot: s.presentation_name_snapshot,
            quantity: s.quantity,
            sortOrder: s.sort_order,
          })),
        }));
        setCart(loadedCart);

        // Consultar presentaciones actuales del catálogo para comparar precios
        const presIds = items.map((i: any) => i.presentation_id);
        const presMap = await getPresentationsByIds(presIds);
        setCurrentPresMap(presMap);

        const diffs: PriceDiffItem[] = [];
        let estimatedTotal = 0;

        for (const item of items) {
          const pres = presMap.get(item.presentation_id);
          const historicalPrice = Number(item.unit_price_cents_snapshot);
          const currentPrice = pres ? pres.price_cents : historicalPrice;
          estimatedTotal += currentPrice * item.quantity;

          if (pres && pres.price_cents !== historicalPrice) {
            diffs.push({
              productId: item.product_id,
              presentationId: item.presentation_id,
              productName: item.product_name_snapshot,
              presentationName: item.presentation_name_snapshot,
              historicalPriceCents: historicalPrice,
              currentPriceCents: pres.price_cents,
              quantity: item.quantity,
            });
          }
        }

        setOriginalOrderTotalCents(order.total_cents);
        setEstimatedNewTotalCents(estimatedTotal);

        if (diffs.length > 0) {
          setPriceDifferences(diffs);
          setPriceDiffModalVisible(true);
        }

        setStep("products");
      })
      .catch((err) => {
        Alert.alert("Error", err?.message || "No se pudo cargar la preventa para editar.", [
          { text: "Volver", onPress: () => navigation.goBack() },
        ]);
      })
      .finally(() => {
        setLoadingOrder(false);
      });
  }, [editingOrderId, navigation]);

  const totals = useMemo(() => {
    try {
      return calcOrderTotals(cart, 0);
    } catch {
      return { subtotalCents: 0, taxCents: 0, totalCents: 0, itemCount: 0 };
    }
  }, [cart]);

  const addToCart = useCallback((product: Product, presentation: Presentation, quantity: number) => {
    try {
      const current = cartRef.current;
      const existingIdx = current.findIndex((l) => l.presentationId === presentation.id && !l.isCombo);
      if (existingIdx >= 0) {
        const updated = recalcLineQuantity(current[existingIdx], current[existingIdx].quantity + quantity);
        setCart(current.map((l, i) => (i === existingIdx ? updated : l)));
      } else {
        const line = buildCartLine(product, presentation, quantity);
        setCart([...current, line]);
      }
    } catch (err) {
      if (err instanceof PricingError) Alert.alert("No se pudo agregar", err.message);
      else Alert.alert("No se pudo agregar", "Ocurrió un error inesperado al agregar el producto.");
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
      try {
        const line: CartLine = {
          ...buildCartLine(product, presentation, quantity),
          isCombo: true,
          comboCatalogSnapshot: captureComboCatalog(product.combo_definition),
          selections,
        };
        setCart((prev) => [...prev, line]);
      } catch (err) {
        if (err instanceof PricingError) Alert.alert("No se pudo agregar", err.message);
        else Alert.alert("No se pudo agregar", "Ocurrió un error inesperado al agregar el combo.");
      }
    },
    []
  );

  const handleCloseComboModal = useCallback(() => {
    setComboModalVisible(false);
    setComboModalProduct(null);
    setComboModalPresentation(null);
  }, []);

  const changeLineQuantity = useCallback((index: number, delta: number) => {
    try {
      const current = cartRef.current;
      const next = current
        .map((line, i) => {
          if (i !== index) return line;
          const quantity = line.quantity + delta;
          return quantity > 0 ? recalcLineQuantity(line, quantity) : null;
        })
        .filter((line): line is CartLine => line !== null);
      setCart(next);
    } catch (err) {
      if (err instanceof PricingError) Alert.alert("No se pudo actualizar", err.message);
      else Alert.alert("No se pudo actualizar", "Ocurrió un error inesperado al actualizar la cantidad.");
    }
  }, []);

  const handleSelectClient = useCallback(
    (client: Client) => {
      if (isEditing) return;
      setSelectedClient(client);
      setStep("products");
    },
    [isEditing]
  );

  const handleKeepHistoricalPrices = useCallback(() => {
    setPriceDecision("historical");
    setPriceDiffModalVisible(false);
  }, []);

  const handleUseCurrentPrices = useCallback(() => {
    setPriceDecision("current");
    setPriceDiffModalVisible(false);
    setCart((prev) =>
      prev.map((line) => {
        const pres = currentPresMap.get(line.presentationId);
        if (pres && pres.price_cents !== line.unitPriceCents) {
          return updateLineUnitPrice(line, pres.price_cents);
        }
        return line;
      })
    );
  }, [currentPresMap]);

  const handleCancelEditing = useCallback(() => {
    setPriceDiffModalVisible(false);
    navigation.goBack();
  }, [navigation]);

  function handleSaveOrder() {
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
    if (isEditing && priceDecision === "current") {
      setCartModalVisible(false);
      setFinalConfirmModalVisible(true);
      return;
    }
    void executeSaveOrder();
  }

  async function executeSaveOrder(offlineConsentKey?: string) {
    if (saveInFlightRef.current) return;
    if (!selectedClient) {
      setError("Selecciona un cliente antes de guardar.");
      return;
    }
    if (cart.length === 0) {
      setError("Agrega al menos un producto.");
      return;
    }
    const capturedDraftKey = saleDraftKey(selectedClient.id, cart, editingOrderId);
    const draftIsCurrent = () => focusedRef.current && draftKeyRef.current === capturedDraftKey;
    if (!draftIsCurrent()) return;
    saveInFlightRef.current = true;
    setSaving(true);
    try {
      const currentWd = await getTodayWorkDay(user!.id);
      if (!draftIsCurrent()) return;
      const localWdId = currentWd.id;
      setWorkDay(currentWd);

      if (currentWd.status === "closed") {
        setError("La jornada de hoy ya fue concluida. Debes reabrir la jornada para registrar preventas.");
        Alert.alert(
          "Jornada Concluida",
          "La jornada está cerrada. Para añadir nuevas preventas debes reabrirla.",
          [
            { text: "Entendido", style: "cancel" },
            { text: "Reabrir Jornada", onPress: handleReopen },
          ]
        );
        return;
      }

      let unverified = offlineConsentKey === capturedDraftKey;
      if (!unverified) {
        const validation = await measurePerformance("sale.catalog_validation", () => validateSaleDraft(selectedClient, cart, {
          online: connection !== "offline", editingOrderId,
        }));
        if (!draftIsCurrent()) {
          if (focusedRef.current) setError("El pedido cambió durante la comprobación. Revisa el carrito y vuelve a guardar.");
          return;
        }
        if (validation.status === "unverified") {
          unverified = true;
          if (validation.reason !== "offline") {
            Alert.alert("No se pudo verificar el catálogo", `${validation.message}\n\nSi guardas sin verificar, los cambios quedarán pendientes y podrían requerir corregir el cliente o los productos al sincronizar.`, [
              { text: "Volver a revisar", style: "cancel" },
              { text: "Guardar sin verificar", onPress: () => {
                if (draftIsCurrent()) void executeSaveOrder(capturedDraftKey);
              } },
            ]);
            return;
          }
        } else if (!validation.valid) {
          const messages = [...new Set(validation.issues.map(issue => issue.message))];
          const message = messages.slice(0, 6).join("\n") || "El cliente o los productos cambiaron. Revisa la preventa antes de guardar.";
          setError(message);
          const clientUnavailable = validation.issues.some(issue => issue.entity === "client");
          if (clientUnavailable && !isEditing) {
            setSelectedClient(null);
            setClients(previous => previous.filter(client => client.id !== selectedClient.id));
            setStep("client");
            setCartModalVisible(false);
            setFinalConfirmModalVisible(false);
          }
          const blockedLines = new Set(validation.issues.flatMap(issue => issue.lineIndex == null ? [] : [issue.lineIndex]));
          Alert.alert(clientUnavailable ? "Cliente no disponible" : "El catálogo cambió", message, [
            { text: "Revisar", style: "cancel" },
            ...(blockedLines.size > 0 && !clientUnavailable ? [{ text: "Quitar no disponibles", onPress: () => {
              if (!draftIsCurrent()) return;
              setCart(previous => previous.filter((_line, index) => !blockedLines.has(index)));
              approvedCatalogRef.current = null;
            } }] : []),
            { text: "Actualizar lista", onPress: () => { void forceSync().catch(() => {}); } },
          ]);
          return;
        } else {
          unverified = validation.unchecked;
          const historicalPrices = priceDecision === "historical"
            ? new Map([...currentPresMap.entries()].map(([id, presentation]) => [id, presentation.price_cents]))
            : undefined;
          const review = reviewSaleCatalog(selectedClient, cart, validation, historicalPrices);
          const approvalKey = JSON.stringify([review.catalogKey, capturedDraftKey]);
          if (review.changes.length > 0 && approvedCatalogRef.current !== approvalKey) {
            const summary = review.changes.slice(0, 6).join("\n") + (review.changes.length > 6 ? `\nY ${review.changes.length - 6} cambio(s) más.` : "");
            const applyReview = (useCurrentPrices: boolean) => {
              if (!draftIsCurrent()) return;
              const reviewedLines = useCurrentPrices ? review.currentLines : review.preservedLines;
              approvedCatalogRef.current = JSON.stringify([review.catalogKey, saleDraftKey(selectedClient.id, reviewedLines, editingOrderId)]);
              setSelectedClient(review.refreshedClient);
              setCart(reviewedLines);
              setError("Catálogo revisado. Verifica el total del carrito y vuelve a confirmar para guardar.");
            };
            Alert.alert(review.priceChanged ? "Los precios cambiaron" : "El catálogo cambió", `${summary}${review.priceChanged ? `\n\nTotal del carrito: ${centsToBs(review.previousTotalCents)}\nCon precios actuales: ${centsToBs(review.currentTotalCents)}` : ""}\n\nRevisa los cambios y vuelve a confirmar el pedido.`, [
              { text: "Volver", style: "cancel" },
              { text: review.priceChanged ? "Mantener precios" : "Actualizar pedido", onPress: () => applyReview(false) },
              ...(review.priceChanged ? [{ text: "Usar precios actuales", onPress: () => applyReview(true) }] : []),
            ]);
            return;
          }
        }
      }
      if (!draftIsCurrent()) return;

      await measurePerformance("sale.local_save", async () => {
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
      });
      // Después de la comprobación breve, SQLite y outbox se confirman sin esperar al push.
      void pushSync().catch(() => {});
      setCart([]);
      setSelectedClient(null);
      setCartModalVisible(false);
      setFinalConfirmModalVisible(false);
      setStep("client");
      approvedCatalogRef.current = null;
      Alert.alert(editingOrderId ? "Preventa actualizada" : "Preventa guardada", unverified
        ? "Guardada en este teléfono. El cliente y los productos se comprobarán al sincronizar; si cambiaron, la preventa se conservará pendiente para revisarla."
        : "Se sincronizará automáticamente.");
      if (editingOrderId) navigation.goBack();
      else navigation.navigate("Registros");
    } catch (err: any) {
      const msg = err.message || "No se pudo guardar la preventa.";
      setError(msg);
      Alert.alert("Error al guardar", msg);
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

  if (isEditing && loadingOrder) {
    return (
      <View style={[styles.screen, { justifyContent: "center", alignItems: "center" }]}>
        <ActivityIndicator size="large" color={colors.emerald} style={{ marginBottom: spacing.md }} />
        <Text style={{ fontSize: 16, color: colors.textSecondary }}>Cargando preventa...</Text>
      </View>
    );
  }

  if (!isEditing && step === "client") {
    return (
      <View style={styles.screen}>
        <View style={styles.stepHeader}>
          <Text style={styles.stepTitle}>Paso 1: Cliente</Text>
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
        {catalogError && <Text style={[styles.error, { marginHorizontal: spacing.lg }]}>{catalogError}</Text>}

        <FlatList
          data={clients}
          keyExtractor={clientKeyExtractor}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ padding: spacing.lg, paddingTop: 0 }}
          ListEmptyComponent={loadingClients ? <ActivityIndicator color={colors.emerald} /> : <EmptyState message="No se encontraron clientes." />}
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
          <Text style={styles.stepTitle}>{isEditing ? "Editar preventa" : "Paso 2: Productos"}</Text>
          {cart.length > 0 && (
            <Pressable style={styles.headerCartBadge} onPress={() => setCartModalVisible(true)}>
              <Text style={styles.headerCartBadgeText}>🛒 {totals.itemCount} ({centsToBs(totals.totalCents)})</Text>
            </Pressable>
          )}
        </View>
        {isEditing ? (
          <View>
            <Text style={styles.changeClient}>
              Cliente: {formatClientDisplayName(selectedClient).primary}
            </Text>
          </View>
        ) : (
          <Pressable onPress={() => setStep("client")}>
            <Text style={styles.changeClient}>
              Cliente: {formatClientDisplayName(selectedClient).primary} · Cambiar
            </Text>
          </Pressable>
        )}
        {connection === "offline" && (
          <Text style={styles.offlineHint}>Sin conexión: el cliente y los productos se verificarán al sincronizar.</Text>
        )}
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

      {catalogError && <Text style={[styles.error, { marginHorizontal: spacing.lg }]}>{catalogError}</Text>}
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
        ListEmptyComponent={loadingProducts ? <ActivityIndicator color={colors.emerald} /> : <EmptyState message="No hay productos disponibles para este filtro." />}
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

      <CartReviewModal visible={cartModalVisible} selectedClient={selectedClient} offline={connection === "offline"}
        cart={cart} totals={totals} error={error} saving={saving} editing={isEditing}
        onClose={() => setCartModalVisible(false)} onChangeQty={changeLineQuantity} onSave={handleSaveOrder} />

      <ComboSelectorModal
        visible={comboModalVisible}
        product={comboModalProduct}
        presentation={comboModalPresentation}
        onAdd={handleAddComboToCart}
        onClose={handleCloseComboModal}
      />

      <PriceReviewModal visible={priceDiffModalVisible} differences={priceDifferences}
        originalTotalCents={originalOrderTotalCents} estimatedTotalCents={estimatedNewTotalCents}
        onKeepHistorical={handleKeepHistoricalPrices} onUseCurrent={handleUseCurrentPrices} onCancel={handleCancelEditing} />

      <FinalPriceConfirmModal visible={finalConfirmModalVisible} originalTotalCents={originalOrderTotalCents}
        totals={totals} saving={saving} onClose={() => setFinalConfirmModalVisible(false)}
        onConfirm={() => { setFinalConfirmModalVisible(false); void executeSaveOrder(); }} />
    </View>
  );
}

const styles = StyleSheet.create({
  error: { color: colors.errorText, marginTop: spacing.sm },
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
  offlineHint: { color: colors.amberText, marginTop: spacing.xs, fontSize: 12 },
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
});
