import React, { useCallback, useState } from "react";
import { View, Text, ScrollView, StyleSheet, RefreshControl, Alert } from "react-native";
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import { colors, spacing, radius } from "../theme/tokens";
import { Card } from "../components/Card";
import { StatusPill } from "../components/StatusPill";
import { Button } from "../components/Button";
import { useAuth } from "../context/AuthContext";
import { useSync } from "../context/SyncContext";
import { getOrCreateOpenWorkDay, listClosedWorkDays } from "../db/repositories/workdays";
import { listOrdersForWorkDay, cancelOrderLocal } from "../db/repositories/orders";
import { centsToBs } from "../domain/pricing";
import { LocalOrder, WorkDay } from "../domain/types";

export function DashboardScreen() {
  const { user, logout } = useAuth();
  const { connection, pendingCount, forceSync, lastError, discardFailedItems, resetLocalData } = useSync();
  const navigation = useNavigation<any>();

  const [workDay, setWorkDay] = useState<WorkDay | null>(null);
  const [recentOrders, setRecentOrders] = useState<LocalOrder[]>([]);
  const [yesterdayTotal, setYesterdayTotal] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    if (!user) return;
    const wd = await getOrCreateOpenWorkDay(user.id);
    setWorkDay(wd);
    const orders = await listOrdersForWorkDay(wd.id);
    setRecentOrders(orders.slice(0, 5));

    const closed = await listClosedWorkDays(user.id);
    const yesterdayStr = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const yesterday = closed.find((w) => w.work_date === yesterdayStr);
    setYesterdayTotal(yesterday ? yesterday.total_cents : null);
  }, [user]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  async function onRefresh() {
    setRefreshing(true);
    await forceSync();
    await load();
    setRefreshing(false);
  }

  if (!user || !workDay) return null;

  const diffFromYesterday =
    yesterdayTotal !== null && yesterdayTotal > 0
      ? Math.round(((workDay.total_cents - yesterdayTotal) / yesterdayTotal) * 100)
      : null;

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={{ padding: spacing.lg, paddingBottom: spacing.xxl }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
    >
      <View style={styles.headerRow}>
        <View>
          <Text style={styles.greeting}>Hola, {user.fullName.split(" ")[0]}</Text>
          <Text style={styles.date}>{new Date().toLocaleDateString("es-BO", { weekday: "long", day: "numeric", month: "long" })}</Text>
        </View>
        <View style={styles.headerActions}>
          <StatusPill
            kind={connection === "syncing" ? "syncing" : connection === "online" ? "online" : "offline"}
            label={connection === "syncing" ? "Sincronizando..." : connection === "online" ? "En línea" : "Sin conexión"}
          />
          <Button
            label="Salir"
            variant="outline"
            onPress={() => Alert.alert("Cerrar sesión", "¿Deseas cerrar la sesión actual?", [
              { text: "Cancelar", style: "cancel" },
              { text: "Salir", style: "destructive", onPress: logout },
            ])}
            style={styles.logoutButton}
          />
        </View>
      </View>

      <Card style={{ backgroundColor: colors.navy, marginTop: spacing.lg }}>
        <Text style={styles.totalLabel}>Total preventado hoy</Text>
        <Text style={styles.totalValue}>{centsToBs(workDay.total_cents)}</Text>
        <View style={styles.metaRow}>
          <Text style={styles.metaText}>{workDay.order_count} preventa{workDay.order_count === 1 ? "" : "s"}</Text>
          {diffFromYesterday !== null && (
            <Text style={[styles.metaText, { color: diffFromYesterday >= 0 ? colors.emeraldTint : colors.errorBg }]}>
              {diffFromYesterday >= 0 ? "▲" : "▼"} {Math.abs(diffFromYesterday)}% vs. ayer
            </Text>
          )}
        </View>
      </Card>

      {pendingCount > 0 && (
        <Card style={{ marginTop: spacing.md, backgroundColor: colors.amberBg, borderColor: colors.amberBg }}>
          <Text style={{ color: colors.amberText, fontWeight: "600" }}>
            {pendingCount} cambio{pendingCount === 1 ? "" : "s"} pendiente{pendingCount === 1 ? "" : "s"} de sincronizar
          </Text>
          <Button label="Forzar Sincro" onPress={forceSync} variant="outline" style={{ marginTop: spacing.sm }} />
          <Button
            label="Reiniciar datos locales"
            onPress={() => Alert.alert(
              "Reiniciar datos locales",
              "Se borrarán las preventas y cola guardadas solo en este teléfono. El servidor no se modifica.",
              [{ text: "Cancelar", style: "cancel" }, { text: "Reiniciar", style: "destructive", onPress: async () => { await resetLocalData(); await load(); Alert.alert("Datos locales reiniciados", "La app descargó nuevamente los datos del servidor."); } }]
            )}
            variant="danger"
            style={{ marginTop: spacing.sm }}
          />
        </Card>
        
      )}

      {lastError && (
        <Card style={{ marginTop: spacing.md, backgroundColor: colors.errorBg }}>
          <Text style={{ color: "#7a1a12", fontWeight: "600" }}>Error de sincronización:</Text>
          <Text style={{ color: "#7a1a12", marginTop: 4 }}>{lastError}</Text>
          <Button
            label="Descartar pendientes con error"
            onPress={discardFailedItems}
            variant="outline"
            style={{ marginTop: spacing.sm }}
          />
        </Card>
      )}

      <View style={styles.quickRow}>
        <Button label="Nueva Preventa" onPress={() => navigation.navigate("Preventa")} style={{ flex: 1, marginRight: spacing.sm }} />
        <Button label="Nuevo Cliente" onPress={() => navigation.navigate("NuevoCliente")} variant="outline" style={{ flex: 1 }} />
      </View>

      <Text style={styles.sectionTitle}>Preventas recientes</Text>
      {recentOrders.length === 0 ? (
        <Card>
          <Text style={{ color: colors.textMuted }}>Aún no registras preventas hoy.</Text>
        </Card>
      ) : (
        recentOrders.map((o) => (
          <Card key={o.id} style={{ marginBottom: spacing.sm }}>
            <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
              <Text style={styles.orderClient}>{o.client_name}</Text>
              <StatusPill kind={o.sync_status === "synced" ? "synced" : o.sync_status === "failed" ? "failed" : "pending"} />
            </View>
            <Text style={styles.orderTotal}>{centsToBs(o.total_cents)} · {o.item_count} items</Text>
            <View style={styles.actionsRow}>
              <Button label="Ver" variant="outline" onPress={() => navigation.navigate("DetallePreventa", { orderId: o.id })} style={{ flex: 1 }} />
              <Button label="Editar" variant="outline" onPress={() => navigation.navigate("EditarPreventa", { orderId: o.id })} style={{ flex: 1 }} />
              <Button label="Eliminar" variant="danger" onPress={() => Alert.alert("Eliminar preventa", "La preventa se cancelará.", [{ text: "Cancelar", style: "cancel" }, { text: "Eliminar", style: "destructive", onPress: async () => { await cancelOrderLocal(o.id); await forceSync(); await load(); } }])} style={{ flex: 1 }} />
            </View>
          </Card>
        ))
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  headerRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start" },
  headerActions: { flexDirection: "row", alignItems: "center" },
  logoutButton: { minHeight: 34, paddingHorizontal: 10, marginLeft: spacing.sm },
  greeting: { fontSize: 20, fontWeight: "700", color: colors.textPrimary },
  date: { fontSize: 13, color: colors.textSecondary, textTransform: "capitalize" },
  totalLabel: { color: colors.surfaceAlt3, fontSize: 13 },
  totalValue: { color: "#fff", fontSize: 32, fontWeight: "700", marginTop: 4 },
  metaRow: { flexDirection: "row", justifyContent: "space-between", marginTop: spacing.md },
  metaText: { color: colors.surfaceAlt3, fontSize: 12 },
  quickRow: { flexDirection: "row", marginTop: spacing.lg },
  sectionTitle: { fontSize: 15, fontWeight: "700", color: colors.textPrimary, marginTop: spacing.xl, marginBottom: spacing.sm },
  orderClient: { fontWeight: "600", color: colors.textPrimary },
  orderTotal: { color: colors.textSecondary, fontSize: 13, marginTop: 2 },
  actionsRow: { flexDirection: "row", gap: spacing.sm, marginTop: spacing.md },
});
