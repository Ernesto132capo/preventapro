import React, { useCallback, useEffect, useState } from "react";
import { View, Text, FlatList, ScrollView, Pressable, StyleSheet, TextInput, Alert } from "react-native";
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import { colors, spacing, radius } from "../theme/tokens";
import { Card } from "../components/Card";
import { StatusPill } from "../components/StatusPill";
import { Button } from "../components/Button";
import { EmptyState } from "../components/EmptyState";
import { useAuth } from "../context/AuthContext";
import { useSync } from "../context/SyncContext";
import { getOrCreateOpenWorkDay, resolveServerWorkDayId, markWorkDayClosed, upsertServerWorkDay, reopenWorkDayLocal } from "../db/repositories/workdays";
import { listOrdersForWorkDay, countUnsyncedOrders, getConsolidatedProductsForWorkDay, ConsolidatedProductRow } from "../db/repositories/orders";
import { formatClientDisplayName } from "../domain/client-display";
import { centsToBs } from "../domain/pricing";
import { LocalOrder, WorkDay } from "../domain/types";
import { apiFetch, ApiError } from "../services/api";

export function DailySalesScreen() {
  const { user } = useAuth();
  const { forceSync, connection, syncTick } = useSync();
  const navigation = useNavigation<any>();

  const [workDay, setWorkDay] = useState<WorkDay | null>(null);
  const [orders, setOrders] = useState<LocalOrder[]>([]);
  const [activeTab, setActiveTab] = useState<"orders" | "products">("orders");
  const [consolidatedData, setConsolidatedData] = useState<{
    items: ConsolidatedProductRow[];
    grandTotalCents: number;
    grandTotalUnits: number;
  }>({ items: [], grandTotalCents: 0, grandTotalUnits: 0 });
  const [showCloseForm, setShowCloseForm] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [closing, setClosing] = useState(false);
  const [reopening, setReopening] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!user) return;
    const wd = await getOrCreateOpenWorkDay(user.id);
    const [ords, consolidated] = await Promise.all([
      listOrdersForWorkDay(wd.id),
      getConsolidatedProductsForWorkDay(wd.id),
    ]);
    setOrders(ords);
    setConsolidatedData(consolidated);
    const totalCents = wd.status === "closed"
      ? wd.total_cents
      : ords.reduce((sum, o) => sum + (o.total_cents || 0), 0);
    const orderCount = wd.status === "closed" ? wd.order_count : ords.length;
    setWorkDay({
      ...wd,
      total_cents: totalCents,
      order_count: orderCount,
    });
  }, [user]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  // Recarga automática cada vez que termina un sync en background
  useEffect(() => {
    if (syncTick > 0) load();
  }, [syncTick]);

  async function handleClose() {
    if (closing || reopening) return;
    setError(null);
    if (confirmText !== "CONFIRMAR") {
      setError('Debes escribir exactamente "CONFIRMAR".');
      return;
    }
    if (!workDay) return;

    setClosing(true);
    try {
      // Confirmar que altas, ediciones y cancelaciones llegaron al servidor
      // antes de consolidar los totales de cierre.
      await forceSync();
      const pending = await countUnsyncedOrders(workDay.id);
      if (pending > 0) {
        setError(`Aún hay ${pending} preventa(s) sin sincronizar. Verifica tu conexión e intenta de nuevo.`);
        return;
      }

      const serverId = await resolveServerWorkDayId(workDay.id);
      if (!serverId) {
        setError("No se pudo confirmar la jornada con el servidor. Verifica tu conexión.");
        return;
      }

      const res = await apiFetch<any>(`/workdays/${serverId}/close`, {
        method: "POST",
        body: { confirmation: confirmText },
      });
      await markWorkDayClosed(workDay.id, res.workDay.order_count, res.workDay.total_cents);
      await upsertServerWorkDay(workDay.id, res.workDay);
      setWorkDay((current) => current ? {
        ...current,
        status: "closed",
        order_count: res.workDay.order_count,
        total_cents: res.workDay.total_cents,
      } : current);
      setShowCloseForm(false);
      Alert.alert(
        "Jornada concluida",
        `Total final del día: ${centsToBs(res.workDay.total_cents)}. Preventas concluidas: ${res.workDay.order_count}.`
      );
      // El cierre ya está confirmado; un fallo de refresco no debe reportarlo
      // como si el servidor hubiera rechazado el cierre.
      try { await forceSync(); } catch { /* cierre confirmado */ }
      try { await load(); } catch { /* se conserva el total confirmado arriba */ }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo cerrar la jornada.");
    } finally {
      setClosing(false);
    }
  }

  async function handleReopen() {
    if (reopening || closing) return;
    if (!workDay) return;
    setReopening(true);
    try {
      const serverId = await resolveServerWorkDayId(workDay.id);
      if (serverId) {
        await apiFetch(`/workdays/${serverId}/reopen`, { method: "POST" });
      }
      await reopenWorkDayLocal(workDay.id);
      await forceSync();
      await load();
      Alert.alert("Jornada reabierta", "Puedes seguir registrando pedidos en la jornada de hoy.");
    } catch (err: any) {
      Alert.alert("Error al reabrir", err?.message || "No se pudo reabrir la jornada.");
    } finally {
      setReopening(false);
    }
  }

  if (!workDay) return null;

  return (
    <View style={styles.screen}>
      <View style={styles.headerRow}>
        <Text style={styles.title}>Jornada Activa</Text>
        <Button label="Registros Históricos" variant="outline" onPress={() => navigation.navigate("Historial")} style={styles.historyBtn} />
      </View>

      <Card style={{ marginHorizontal: spacing.lg, marginBottom: spacing.md }}>
        <View style={styles.rowBetween}>
          <Text style={styles.summaryLabel}>{workDay.work_date}</Text>
          <StatusPill kind={workDay.status === "open" ? "waiting" : "synced"} label={workDay.status === "open" ? "Abierta" : "Cerrada"} />
        </View>
        <Text style={styles.summaryTotal}>{centsToBs(workDay.total_cents)}</Text>
        <Text style={styles.summarySub}>{workDay.order_count} preventa(s)</Text>
      </Card>

      <View style={styles.tabContainer}>
        <Pressable
          style={[styles.tabButton, activeTab === "orders" && styles.tabButtonActive]}
          onPress={() => setActiveTab("orders")}
        >
          <Text style={[styles.tabButtonText, activeTab === "orders" && styles.tabButtonTextActive]}>
            📦 Preventas ({orders.length})
          </Text>
        </Pressable>
        <Pressable
          style={[styles.tabButton, activeTab === "products" && styles.tabButtonActive]}
          onPress={() => setActiveTab("products")}
        >
          <Text style={[styles.tabButtonText, activeTab === "products" && styles.tabButtonTextActive]}>
            📊 Lista de Productos ({consolidatedData.items.length})
          </Text>
        </Pressable>
      </View>

      {activeTab === "products" ? (
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ paddingHorizontal: spacing.lg, paddingBottom: spacing.lg }}
        >
          <Card style={{ padding: 0, overflow: "hidden" }}>
            <View style={styles.tableHeaderRow}>
              <Text style={[styles.tableHeaderCell, styles.colProduct]}>Producto</Text>
              <Text style={[styles.tableHeaderCell, styles.colPrice]}>P. Unit.</Text>
              <Text style={[styles.tableHeaderCell, styles.colPrice]}>P. Total</Text>
              <Text style={[styles.tableHeaderCell, styles.colUnits]}>Unid.</Text>
            </View>

            {consolidatedData.items.length === 0 ? (
              <View style={{ padding: spacing.lg }}>
                <EmptyState message="Aún no hay productos pedidos en esta jornada." />
              </View>
            ) : (
              <>
                {consolidatedData.items.map((prod, idx) => (
                  <View
                    key={`${prod.productName}-${prod.unitPriceCents}-${idx}`}
                    style={[styles.tableRow, idx % 2 === 1 && styles.tableRowAlt]}
                  >
                    <Text style={[styles.tableCell, styles.colProduct, styles.productNameText]}>
                      {prod.productName}
                    </Text>
                    <Text style={[styles.tableCell, styles.colPrice]}>
                      {centsToBs(prod.unitPriceCents)}
                    </Text>
                    <Text style={[styles.tableCell, styles.colPrice, styles.subtotalText]}>
                      {centsToBs(prod.totalSubtotalCents)}
                    </Text>
                    <Text style={[styles.tableCell, styles.colUnits, styles.unitsText]}>
                      {prod.totalUnits}
                    </Text>
                  </View>
                ))}

                <View style={styles.tableTotalRow}>
                  <Text style={[styles.tableTotalCell, styles.colProduct]}>TOTAL GENERAL</Text>
                  <Text style={[styles.tableTotalCell, styles.colPrice]}>-</Text>
                  <Text style={[styles.tableTotalCell, styles.colPrice, styles.grandTotalText]}>
                    {centsToBs(consolidatedData.grandTotalCents)}
                  </Text>
                  <Text style={[styles.tableTotalCell, styles.colUnits, styles.grandTotalUnits]}>
                    {consolidatedData.grandTotalUnits}
                  </Text>
                </View>
              </>
            )}
          </Card>
        </ScrollView>
      ) : workDay.status === "closed" ? (
        <View style={{ paddingHorizontal: spacing.lg }}>
          <Card>
            <Text style={{ color: colors.textPrimary, fontWeight: "600", fontSize: 14 }}>
              Jornada concluida
            </Text>
            <Text style={{ color: colors.textSecondary, fontSize: 13, marginTop: 4 }}>
              Las preventas de hoy ya fueron cerradas y consolidadas. Para ver la lista detallada, editar o agregar nuevas preventas, reabre la jornada. También puedes consultar los reportes en Registros Históricos.
            </Text>
            <Button
              label="Reabrir Jornada"
              variant="secondary"
              onPress={() =>
                Alert.alert(
                  "Reabrir jornada",
                  "¿Deseas volver a abrir la jornada para añadir más preventas hoy?",
                  [
                    { text: "Cancelar", style: "cancel" },
                    { text: "Reabrir", onPress: handleReopen },
                  ]
                )
              }
              style={{ marginTop: spacing.md }}
            />
          </Card>
        </View>
      ) : (
        <FlatList
          data={orders}
          keyExtractor={(o) => o.id}
          contentContainerStyle={{ paddingHorizontal: spacing.lg }}
          ListEmptyComponent={<EmptyState message="Aún no hay preventas registradas hoy." />}
          renderItem={({ item }) => {
            const clientDisplay = formatClientDisplayName({
              business_name: item.business_name || item.client_name,
              contact_name: item.contact_name,
            });
            return (
              <Pressable onPress={() => navigation.navigate("DetallePreventa", { orderId: item.id })}>
                <Card style={{ marginBottom: spacing.sm }}>
                  <View style={styles.rowBetween}>
                    <View style={{ flex: 1, marginRight: spacing.sm }}>
                      <Text style={styles.orderClient}>{clientDisplay.primary}</Text>
                      {!!clientDisplay.secondary && (
                        <Text style={styles.orderClientSub}>{clientDisplay.secondary}</Text>
                      )}
                    </View>
                    <StatusPill
                      kind={item.sync_status === "synced" ? "synced" : item.sync_status === "failed" ? "failed" : "pending"}
                    />
                  </View>
                  <Text style={styles.orderMeta}>
                    {item.item_count} items · {new Date(item.created_at).toLocaleTimeString("es-BO", { hour: "2-digit", minute: "2-digit" })}
                  </Text>
                  <Text style={styles.orderTotal}>{centsToBs(item.total_cents)}</Text>
                </Card>
              </Pressable>
            );
          }}
        />
      )}

      {workDay.status === "open" && orders.length > 0 && (
        <View style={styles.closeSection}>
          {!showCloseForm ? (
            <Button label="Concluir preventa del día" onPress={() => setShowCloseForm(true)} variant="secondary" />
          ) : (
            <Card>
              <Text style={styles.closeWarning}>
                Esta acción cerrará la jornada. Escribe CONFIRMAR para continuar (podrás reabrirla si entra un pedido de última hora).
              </Text>
              <TextInput
                style={styles.confirmInput}
                value={confirmText}
                onChangeText={setConfirmText}
                placeholder="CONFIRMAR"
                autoCapitalize="characters"
              />
              {error && <Text style={styles.error}>{error}</Text>}
              <View style={{ flexDirection: "row", marginTop: spacing.md }}>
                <Button label="Cancelar" variant="outline" onPress={() => setShowCloseForm(false)} style={{ flex: 1, marginRight: spacing.sm }} />
                <Button label="Cerrar Jornada" variant="danger" onPress={handleClose} loading={closing} style={{ flex: 1 }} />
              </View>
            </Card>
          )}
        </View>
      )}

    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  headerRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", padding: spacing.lg, paddingBottom: spacing.sm },
  title: { fontSize: 18, fontWeight: "700", color: colors.textPrimary },
  historyBtn: { minHeight: 36, paddingHorizontal: 10 },
  rowBetween: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  summaryLabel: { fontSize: 13, color: colors.textSecondary },
  summaryTotal: { fontSize: 26, fontWeight: "700", color: colors.textPrimary, marginTop: 4 },
  summarySub: { fontSize: 12, color: colors.textMuted },
  orderClient: { fontWeight: "700", color: colors.textPrimary },
  orderClientSub: { fontSize: 12, color: colors.textSecondary, marginTop: 1 },
  orderMeta: { fontSize: 12, color: colors.textMuted, marginTop: 2 },
  orderTotal: { fontSize: 15, fontWeight: "700", color: colors.emeraldDark, marginTop: 4 },
  tabContainer: {
    flexDirection: "row",
    marginHorizontal: spacing.lg,
    marginBottom: spacing.md,
    backgroundColor: colors.surfaceAlt,
    borderRadius: radius.md,
    padding: 3,
  },
  tabButton: {
    flex: 1,
    paddingVertical: 8,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.sm,
  },
  tabButtonActive: {
    backgroundColor: colors.surface,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 2,
    elevation: 1,
  },
  tabButtonText: {
    fontSize: 13,
    fontWeight: "600",
    color: colors.textSecondary,
  },
  tabButtonTextActive: {
    color: colors.textPrimary,
    fontWeight: "700",
  },
  tableHeaderRow: {
    flexDirection: "row",
    backgroundColor: colors.surfaceAlt,
    paddingVertical: 10,
    paddingHorizontal: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    alignItems: "center",
  },
  tableHeaderCell: {
    fontSize: 12,
    fontWeight: "700",
    color: colors.textPrimary,
  },
  tableRow: {
    flexDirection: "row",
    paddingVertical: 10,
    paddingHorizontal: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.surfaceAlt3,
    alignItems: "center",
  },
  tableRowAlt: {
    backgroundColor: colors.surfaceAlt2,
  },
  tableCell: {
    fontSize: 12,
    color: colors.textPrimary,
  },
  colProduct: {
    flex: 2.2,
    textAlign: "left",
    paddingRight: 6,
  },
  colPrice: {
    flex: 1.1,
    textAlign: "right",
    paddingRight: 6,
  },
  colUnits: {
    flex: 0.8,
    textAlign: "right",
  },
  productNameText: {
    fontWeight: "600",
  },
  subtotalText: {
    fontWeight: "600",
    color: colors.emeraldDark,
  },
  unitsText: {
    fontWeight: "700",
  },
  tableTotalRow: {
    flexDirection: "row",
    backgroundColor: colors.surfaceAlt,
    paddingVertical: 12,
    paddingHorizontal: spacing.md,
    borderTopWidth: 1.5,
    borderTopColor: colors.border,
    alignItems: "center",
  },
  tableTotalCell: {
    fontSize: 12,
    fontWeight: "800",
    color: colors.textPrimary,
  },
  grandTotalText: {
    color: colors.emeraldDark,
  },
  grandTotalUnits: {
    color: colors.navy,
  },
  closeSection: { padding: spacing.lg },
  closeWarning: { fontSize: 13, color: colors.textSecondary, marginBottom: spacing.md },
  confirmInput: {
    borderWidth: 1.5,
    borderColor: colors.errorText,
    borderRadius: radius.md,
    minHeight: 48,
    paddingHorizontal: spacing.md,
    textAlign: "center",
    fontWeight: "700",
    letterSpacing: 1,
  },
  error: { color: colors.errorText, marginTop: spacing.sm },
});
