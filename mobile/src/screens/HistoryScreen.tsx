import React, { useCallback, useEffect, useRef, useState } from "react";
import { View, Text, FlatList, StyleSheet, Linking, Alert } from "react-native";
import { useFocusEffect, useIsFocused } from "@react-navigation/native";
import { colors, spacing } from "../theme/tokens";
import { Card } from "../components/Card";
import { StatusPill } from "../components/StatusPill";
import { EmptyState } from "../components/EmptyState";
import { Button } from "../components/Button";
import { useAuth } from "../context/AuthContext";
import { assertClosedWorkDayDeletable, deleteClosedWorkDayLocal, listClosedWorkDays, resolveServerWorkDayId } from "../db/repositories/workdays";
import { listOrdersForWorkDay } from "../db/repositories/orders";
import { centsToBs } from "../domain/pricing";
import { formatClientDisplayName } from "../domain/client-display";
import { WorkDay } from "../domain/types";
import { API_BASE_URL } from "../services/config";
import { apiFetch } from "../services/api";
import { useSync } from "../context/SyncContext";

const PAGE_SIZE = 50;

/** Registros Históricos (Fase 29) — jornadas cerradas, de solo lectura, con enlaces a reportes. */
export function HistoryScreen() {
  const { user } = useAuth();
  const { pullRevision } = useSync();
  const isFocused = useIsFocused();
  const [workDays, setWorkDays] = useState<WorkDay[]>([]);
  const [expandedWorkDayId, setExpandedWorkDayId] = useState<string | null>(null);
  const [ordersMap, setOrdersMap] = useState<Record<string, any[]>>({});
  const [loadingOrders, setLoadingOrders] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const serverOffsetRef = useRef(0);
  const historyRequest = useRef(0);
  const ordersRequest = useRef(0);
  const expandedIdRef = useRef(expandedWorkDayId);
  const observedPullRevision = useRef(pullRevision);
  const visibleDays = useRef<WorkDay[]>([]);
  const moreBusy = useRef(false);
  const [orderPage, setOrderPage] = useState(0);
  expandedIdRef.current = expandedWorkDayId;

  function showDays(days: WorkDay[]) { visibleDays.current = days; setWorkDays(days); }
  function matchDay(days: WorkDay[], id: string | null) {
    return days.find(day => day.id === id || day.server_id === id);
  }

  const loadOrders = useCallback(async (item: WorkDay) => {
    const requestId = ++ordersRequest.current;
    setLoadingOrders(item.id);
    try {
      const localOrders = await listOrdersForWorkDay(item.id);
      if (requestId !== ordersRequest.current) return;
      setOrdersMap((previous) => localOrders.length > 0 || !previous[item.id]
        ? { ...previous, [item.id]: localOrders } : previous);
      const serverId = item.server_id || await resolveServerWorkDayId(item.id);
      if (!serverId) return;
      const res = await apiFetch<any>(`/workdays/${serverId}/orders`);
      if (res?.orders && requestId === ordersRequest.current) {
        setOrdersMap((previous) => ({ ...previous, [item.id]: res.orders }));
      }
    } catch {
      // La copia SQLite ya está visible y admite tanto IDs locales como remotos.
    } finally {
      if (requestId === ordersRequest.current) setLoadingOrders(null);
    }
  }, []);

  const load = useCallback(async () => {
    if (!user) return;
    const requestId = ++historyRequest.current;
    ++ordersRequest.current;
    const localDays = await listClosedWorkDays(user.id);
    if (requestId !== historyRequest.current) return;
    const requestedExpanded = expandedIdRef.current;
    const expandedLocal = matchDay(localDays, requestedExpanded) || matchDay(visibleDays.current, requestedExpanded);
    // El detalle local se recupera sin esperar la petición del historial.
    if (expandedLocal) void loadOrders(expandedLocal);
    const previous = visibleDays.current;
    const known = new Set(previous.flatMap(day => [day.id, day.server_id]));
    showDays(previous.length ? [...localDays.filter(day => !known.has(day.id) && !known.has(day.server_id)), ...previous] : localDays);
    try {
      const res = await apiFetch<{ workDays: any[]; hasMore?: boolean }>(`/workdays/history?limit=${PAGE_SIZE}&offset=0`);
      if (res?.workDays) {
        if (requestId !== historyRequest.current) return;
        const days = res.workDays.map(remote => {
          const local = matchDay(localDays, remote.id);
          return local ? { ...remote, id: local.id, server_id: remote.id } : remote;
        });
        showDays(days);
        serverOffsetRef.current = 0;
        setHasMore(Boolean(res.hasMore));
        if (expandedIdRef.current === requestedExpanded) {
          const expanded = matchDay(days, requestedExpanded) || (expandedLocal && matchDay(days, expandedLocal.server_id || expandedLocal.id));
          if (expanded) {
            expandedIdRef.current = expanded.id;
            setExpandedWorkDayId(expanded.id);
            if (!expandedLocal) void loadOrders(expanded);
          } else {
            expandedIdRef.current = null;
            setExpandedWorkDayId(null);
            ++ordersRequest.current;
            setLoadingOrders(null);
          }
        }
      }
    } catch {
      // Fallback offline
    }
  }, [user, loadOrders]);

  const loadMore = useCallback(async () => {
    if (!hasMore || moreBusy.current) return;
    moreBusy.current = true;
    const requestId = historyRequest.current;
    setLoadingMore(true);
    const offset = serverOffsetRef.current + PAGE_SIZE;
    try {
      const res = await apiFetch<{ workDays: any[]; hasMore?: boolean }>(`/workdays/history?limit=${PAGE_SIZE}&offset=${offset}`);
      if (requestId !== historyRequest.current) return;
      if (res?.workDays) {
        serverOffsetRef.current = offset;
        const seen = new Set(visibleDays.current.flatMap(day => [day.id, day.server_id]));
        showDays([...visibleDays.current, ...res.workDays.filter((day: any) => !seen.has(day.id))]);
        setHasMore(Boolean(res.hasMore));
      }
    } catch {
      // Sin conexión no se puede paginar; el usuario puede reintentar con el botón.
    } finally {
      moreBusy.current = false;
      setLoadingMore(false);
    }
  }, [hasMore, loadingMore]);

  const toggleExpand = async (item: WorkDay) => {
    if (expandedWorkDayId === item.id) {
      expandedIdRef.current = null;
      setExpandedWorkDayId(null);
      ++ordersRequest.current;
      setLoadingOrders(null);
      return;
    }
    expandedIdRef.current = item.id;
    setOrderPage(0);
    setExpandedWorkDayId(item.id);
    await loadOrders(item);
  };

  useFocusEffect(
    useCallback(() => {
      void load().catch(() => {});
      return () => { ++historyRequest.current; ++ordersRequest.current; };
    }, [load])
  );

  useEffect(() => {
    const changed = observedPullRevision.current !== pullRevision;
    observedPullRevision.current = pullRevision;
    if (isFocused && changed && pullRevision > 0) void load().catch(() => {});
  }, [isFocused, pullRevision, load]);

  async function openReport(workDayServerId: string, fileName: string) {
    try {
      const { downloadToken } = await apiFetch<{ downloadToken: string }>(`/reports/${workDayServerId}/download-token`, { method: "POST" });
      await Linking.openURL(`${API_BASE_URL}/reports/${workDayServerId}/${fileName}?download_token=${encodeURIComponent(downloadToken)}`);
    } catch (err: any) {
      Alert.alert("No se pudo abrir el reporte", err?.message || "Verifica tu conexión e inténtalo de nuevo.");
    }
  }

  async function deleteRecord(item: WorkDay) {
    try {
      await assertClosedWorkDayDeletable(item.id);
      const serverId = item.server_id || await resolveServerWorkDayId(item.id);
      if (!serverId) throw new Error("Sincroniza esta jornada antes de eliminarla del historial.");
      await apiFetch(`/workdays/${serverId}`, { method: "DELETE" });
      await deleteClosedWorkDayLocal(item.id);
      showDays(visibleDays.current.filter(day => day.id !== item.id && day.server_id !== serverId && day.id !== serverId));
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
        ListFooterComponent={
          hasMore ? (
            <Button
              label={loadingMore ? "Cargando..." : "Cargar más jornadas"}
              variant="outline"
              onPress={loadMore}
              loading={loadingMore}
              disabled={loadingMore}
              style={{ marginTop: spacing.sm, minHeight: 44 }}
            />
          ) : null
        }
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
              const dayOrders = ordersMap[item.id] || [];
              const page = Math.min(orderPage, Math.max(0, Math.ceil(dayOrders.length / 10) - 1));
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
                      {loadingOrders === item.id && !ordersMap[item.id] ? (
                        <Text style={styles.loadingOrdersText}>Cargando preventas...</Text>
                      ) : (ordersMap[item.id] || []).length === 0 ? (
                        <Text style={styles.loadingOrdersText}>No hay preventas registradas en esta jornada.</Text>
                      ) : (
                        <>{dayOrders.slice(page * 10, (page + 1) * 10).map((ord: any, idx: number) => {
                          const clientDisplay = formatClientDisplayName({
                            business_name: ord.business_name || ord.businessName || ord.client_name,
                            contact_name: ord.contact_name || ord.contactName,
                          });
                          return (
                            <View key={ord.id || idx} style={styles.orderCard}>
                              <View style={styles.rowBetween}>
                                <View style={{ flex: 1, marginRight: spacing.sm }}>
                                  <Text style={styles.orderClientText}>{clientDisplay.primary}</Text>
                                  {!!clientDisplay.secondary && (
                                    <Text style={styles.orderClientSubText}>{clientDisplay.secondary}</Text>
                                  )}
                                </View>
                                <Text style={styles.orderTotalText}>{centsToBs(ord.totalCents ?? ord.total_cents ?? 0)}</Text>
                              </View>
                              <Text style={styles.orderSubText}>
                                {ord.item_count ?? (ord.items ? ord.items.length : 0)} producto(s) · {ord.payment_condition || ord.paymentCondition || "Contado"}
                              </Text>
                            </View>
                          );
                        })}
                        {dayOrders.length > 10 && <View>
                          <Text style={styles.orderSubText}>{page * 10 + 1}–{Math.min((page + 1) * 10, dayOrders.length)} de {dayOrders.length} preventas</Text>
                          <View style={styles.reportsRow}>
                            <Button label="Anterior" variant="outline" disabled={page === 0} onPress={() => setOrderPage(page - 1)} />
                            <Button label="Siguiente" variant="outline" disabled={(page + 1) * 10 >= dayOrders.length} onPress={() => setOrderPage(page + 1)} />
                          </View>
                        </View>}</>
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
  orderClientSubText: { fontSize: 12, color: colors.textSecondary, marginTop: 1 },
  orderTotalText: { fontSize: 14, fontWeight: "700", color: colors.navy },
  orderSubText: { fontSize: 12, color: colors.textSecondary, marginTop: 2 },
});
