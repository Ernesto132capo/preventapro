import React, { useCallback, useState } from "react";
import { View, Text, FlatList, StyleSheet, Linking, Alert } from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import { colors, spacing } from "../theme/tokens";
import { Card } from "../components/Card";
import { StatusPill } from "../components/StatusPill";
import { EmptyState } from "../components/EmptyState";
import { Button } from "../components/Button";
import { useAuth } from "../context/AuthContext";
import { deleteClosedWorkDayLocal, listClosedWorkDays } from "../db/repositories/workdays";
import { listOrdersForWorkDay } from "../db/repositories/orders";
import { centsToBs } from "../domain/pricing";
import { WorkDay } from "../domain/types";
import { API_BASE_URL } from "../services/config";
import { apiFetch, getAccessToken } from "../services/api";

/** Registros Históricos (Fase 29) — jornadas cerradas, de solo lectura, con enlaces a reportes. */
export function HistoryScreen() {
  const { user } = useAuth();
  const [workDays, setWorkDays] = useState<WorkDay[]>([]);
  const [expandedWorkDayId, setExpandedWorkDayId] = useState<string | null>(null);
  const [ordersMap, setOrdersMap] = useState<Record<string, any[]>>({});
  const [loadingOrders, setLoadingOrders] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch<{ workDays: any[] }>("/workdays/history");
      if (res?.workDays) {
        setWorkDays(res.workDays);
        return;
      }
    } catch {
      // Fallback offline
    }
    setWorkDays(await listClosedWorkDays());
  }, []);

  const toggleExpand = async (item: WorkDay) => {
    if (expandedWorkDayId === item.id) {
      setExpandedWorkDayId(null);
      return;
    }
    setExpandedWorkDayId(item.id);
    if (!ordersMap[item.id]) {
      const serverId = item.server_id || item.id;
      setLoadingOrders(item.id);
      try {
        const res = await apiFetch<any>(`/workdays/${serverId}/orders`);
        if (res?.orders) {
          setOrdersMap((prev) => ({ ...prev, [item.id]: res.orders }));
        }
      } catch {
        // Fallback local
        const localOrders = await listOrdersForWorkDay(item.id);
        setOrdersMap((prev) => ({ ...prev, [item.id]: localOrders }));
      } finally {
        setLoadingOrders(null);
      }
    }
  };

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  async function openReport(workDayServerId: string, fileName: string) {
    const token = await getAccessToken();
    if (!token) return;
    // El navegador no comparte los headers de la app: el backend valida este
    // token en la ruta de reportes antes de entregar el archivo.
    Linking.openURL(`${API_BASE_URL}/reports/${workDayServerId}/${fileName}?access_token=${encodeURIComponent(token)}`);
  }

  async function deleteRecord(item: WorkDay) {
    if (!item.server_id) return;
    try {
      await apiFetch(`/workdays/${item.server_id}`, { method: "DELETE" });
      await deleteClosedWorkDayLocal(item.id);
      await load();
    } catch (err: any) {
      Alert.alert("No se pudo eliminar", err.message || "Intenta nuevamente.");
    }
  }

  function creationTime(value: string) {
    const normalized = value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
    return new Intl.DateTimeFormat("es-BO", { timeZone: "America/La_Paz", hour: "2-digit", minute: "2-digit" }).format(new Date(normalized));
  }

  return (
    <View style={styles.screen}>
      <FlatList
        data={workDays}
        keyExtractor={(w) => w.id}
        contentContainerStyle={{ padding: spacing.lg }}
        ListEmptyComponent={<EmptyState message="Aún no tienes jornadas cerradas." />}
        renderItem={({ item }) => (
          <Card style={{ marginBottom: spacing.sm }}>
            <View style={styles.rowBetween}>
              <Text style={styles.date}>{item.work_date}</Text>
              <StatusPill kind="synced" label="Cerrada" />
            </View>
            <Text style={styles.total}>{centsToBs(item.total_cents)}</Text>
            <Text style={styles.sub}>{item.order_count} preventa(s)</Text>
            <Text style={styles.sub}>Creado a las {creationTime(item.created_at)}</Text>
            {(() => {
              const serverId = item.server_id || item.id;
              if (!serverId) return null;
              const isExpanded = expandedWorkDayId === item.id;
              return (
                <View style={{ marginTop: spacing.md }}>
                  <Text style={styles.sectionLabel}>Archivos y reportes descargables:</Text>
                  <View style={styles.reportsRow}>
                    <Button
                      label="📊 Lista de productos (.xlsx)"
                      variant="outline"
                      onPress={() => openReport(serverId, "lista_de_productos.xlsx")}
                      style={styles.reportBtn}
                    />
                    <Button
                      label="📑 Resumen de clientes (.xlsx)"
                      variant="outline"
                      onPress={() => openReport(serverId, "resumen_clientes.xlsx")}
                      style={styles.reportBtn}
                    />
                    <Button
                      label="🖨️ Boletas para imprimir (.pdf)"
                      variant="primary"
                      onPress={() => openReport(serverId, "boletas_clientes.pdf")}
                      style={styles.reportBtn}
                    />
                  </View>

                  <Button
                    label={isExpanded ? "Ocultar preventas" : "Ver preventas de esta jornada"}
                    variant="outline"
                    onPress={() => toggleExpand(item)}
                    style={{ marginTop: spacing.sm, minHeight: 38 }}
                  />

                  {isExpanded && (
                    <View style={styles.ordersContainer}>
                      {loadingOrders === item.id ? (
                        <Text style={styles.loadingOrdersText}>Cargando preventas...</Text>
                      ) : (ordersMap[item.id] || []).length === 0 ? (
                        <Text style={styles.loadingOrdersText}>No hay preventas registradas en esta jornada.</Text>
                      ) : (
                        (ordersMap[item.id] || []).map((ord: any, idx: number) => (
                          <View key={ord.id || idx} style={styles.orderCard}>
                            <View style={styles.rowBetween}>
                              <Text style={styles.orderClientText}>{ord.business_name || ord.client_name || "Cliente"}</Text>
                              <Text style={styles.orderTotalText}>{centsToBs(ord.totalCents ?? ord.total_cents ?? 0)}</Text>
                            </View>
                            <Text style={styles.orderSubText}>
                              {ord.item_count ?? (ord.items ? ord.items.length : 0)} producto(s) · {ord.payment_condition || ord.paymentCondition || "Contado"}
                            </Text>
                          </View>
                        ))
                      )}
                    </View>
                  )}
                </View>
              );
            })()}
            <Button
              label="Eliminar registro"
              variant="danger"
              onPress={() => Alert.alert("Eliminar registro", "Se eliminarán esta jornada, sus preventas y reportes. Esta acción no se puede deshacer.", [
                { text: "Cancelar", style: "cancel" },
                { text: "Eliminar", style: "destructive", onPress: () => deleteRecord(item) },
              ])}
              style={{ marginTop: spacing.md, minHeight: 36 }}
            />
          </Card>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  rowBetween: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  date: { fontSize: 14, fontWeight: "700", color: colors.textPrimary, textTransform: "capitalize" },
  total: { fontSize: 22, fontWeight: "700", color: colors.textPrimary, marginTop: 4 },
  sub: { fontSize: 12, color: colors.textMuted },
  sectionLabel: { fontSize: 13, fontWeight: "600", color: colors.textPrimary, marginBottom: spacing.xs },
  reportsRow: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm, marginBottom: spacing.xs },
  reportBtn: { minHeight: 38, paddingHorizontal: 12, flexGrow: 1 },
  ordersContainer: { marginTop: spacing.sm, backgroundColor: colors.surfaceAlt2, padding: spacing.sm, borderRadius: 8 },
  loadingOrdersText: { fontSize: 13, color: colors.textMuted, textAlign: "center", paddingVertical: spacing.sm },
  orderCard: { backgroundColor: colors.surface, padding: spacing.sm, borderRadius: 6, marginBottom: spacing.xs },
  orderClientText: { fontSize: 14, fontWeight: "600", color: colors.textPrimary },
  orderTotalText: { fontSize: 14, fontWeight: "700", color: colors.navy },
  orderSubText: { fontSize: 12, color: colors.textSecondary, marginTop: 2 },
});
