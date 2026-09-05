import React, { useCallback, useEffect, useState } from "react";
import { View, Text, ScrollView, StyleSheet, RefreshControl, Alert } from "react-native";
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import { colors, spacing, radius } from "../theme/tokens";
import { Card } from "../components/Card";
import { StatusPill } from "../components/StatusPill";
import { Button } from "../components/Button";
import { useAuth } from "../context/AuthContext";
import { useSync } from "../context/SyncContext";
import { getOrCreateOpenWorkDay, listClosedWorkDays, reopenWorkDayLocal, resolveServerWorkDayId } from "../db/repositories/workdays";
import { listOrdersForWorkDay, cancelOrderLocal } from "../db/repositories/orders";
import { centsToBs } from "../domain/pricing";
import { LocalOrder, WorkDay } from "../domain/types";
import { apiFetch } from "../services/api";

export function DashboardScreen() {
  const { user, logout } = useAuth();
  const { connection, pendingCount, forceSync, lastError, discardFailedItems, resetLocalData, syncTick } = useSync();
  const navigation = useNavigation<any>();

  const [workDay, setWorkDay] = useState<WorkDay | null>(null);
  const [recentOrders, setRecentOrders] = useState<LocalOrder[]>([]);
  const [yesterdayTotal, setYesterdayTotal] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    if (!user) return;
    const wd = await getOrCreateOpenWorkDay(user.id);
    const orders = await listOrdersForWorkDay(wd.id);
    setRecentOrders(orders.slice(0, 5));

    const totalCents = orders.reduce((sum, o) => sum + (o.total_cents || 0), 0);
    const orderCount = orders.length;
    setWorkDay({
      ...wd,
      total_cents: totalCents,
      order_count: orderCount,
    });

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

  // Recarga automática cada vez que termina un sync en background
  useEffect(() => {
    if (syncTick > 0) load();
  }, [syncTick]);

  const isSyncing = connection === "syncing" || refreshing;

  async function onRefresh() {
    if (isSyncing) return;
    setRefreshing(true);
    try {
      await forceSync();
      await load();
    } finally {
      setRefreshing(false);
    }
  }

  async function handleManualForceSync() {
    if (isSyncing) return;
    try {
      await forceSync();
      await load();
    } catch (err) {
      console.warn("Error en sincronización forzada:", err);
    }
  }

  async function handleReopen() {
    if (!workDay) return;
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
    }
  }

  async function handleDeleteOrder(orderId: string) {
    try {
      await cancelOrderLocal(orderId);
      // Actualizar vista local de inmediato para que no se congele o buguee
      setRecentOrders((prev) => prev.filter((o) => o.id !== orderId));
      await forceSync();
      await load();
    } catch (err: any) {
      Alert.alert("No se pudo eliminar", err?.message || "Ocurrió un problema al eliminar la preventa.");
    }
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
          <Text style={styles.greeting}>Hola, Preventista 👋</Text>
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
        <View style={styles.rowBetween}>
          <Text style={styles.totalLabel}>Total preventado hoy</Text>
          {workDay.status === "closed" && (
            <StatusPill kind="synced" label="Jornada Concluida" />
          )}
        </View>
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

      {workDay.status === "closed" && (
        <Card style={{ marginTop: spacing.md, backgroundColor: colors.surfaceAlt2, borderColor: colors.emerald }}>
          <Text style={{ fontWeight: "700", color: colors.navy, fontSize: 14 }}>
            ✅ La jornada de hoy ya fue concluida.
          </Text>
          <Text style={{ color: colors.textSecondary, fontSize: 13, marginTop: 2 }}>
            Si necesitas añadir más preventas (por ejemplo, pedidos de última hora), puedes reabrir la jornada.
          </Text>
          <View style={{ flexDirection: "row", gap: spacing.sm, marginTop: spacing.sm }}>
            <Button
              label="Reabrir Jornada"
              variant="secondary"
              onPress={() => Alert.alert(
                "Reabrir jornada",
                "¿Deseas volver a abrir la jornada para añadir más preventas hoy?",
                [
                  { text: "Cancelar", style: "cancel" },
                  { text: "Reabrir", onPress: handleReopen },
                ]
              )}
              style={{ flex: 1 }}
            />
            <Button
              label="Ver Reportes"
              variant="outline"
              onPress={() => navigation.navigate("Historial")}
              style={{ flex: 1 }}
            />
          </View>
        </Card>
      )}

      {pendingCount > 0 && (
        <Card style={{ marginTop: spacing.md, backgroundColor: colors.amberBg, borderColor: colors.amberBg }}>
          <Text style={{ color: colors.amberText, fontWeight: "600" }}>
            {pendingCount} cambio{pendingCount === 1 ? "" : "s"} pendiente{pendingCount === 1 ? "" : "s"} de sincronizar
          </Text>
          <Button
            label="Forzar Sincro"
            onPress={handleManualForceSync}
            variant="outline"
            disabled={isSyncing}
            loading={connection === "syncing"}
            style={{ marginTop: spacing.sm }}
          />
          <Button
            label="Reiniciar datos locales"
            onPress={() => Alert.alert(
              "Reiniciar datos locales",
              "Se borrarán las preventas y cola guardadas solo en este teléfono. El servidor no se modifica.",
              [{ text: "Cancelar", style: "cancel" }, { text: "Reiniciar", style: "destructive", onPress: async () => { await resetLocalData(); await load(); Alert.alert("Datos locales reiniciados", "La app descargó nuevamente los datos del servidor."); } }]
            )}
            variant="danger"
            disabled={isSyncing}
            style={{ marginTop: spacing.sm }}
          />
        </Card>
      )}

      {lastError && (
        <Card style={{ marginTop: spacing.md, backgroundColor: colors.errorBg }}>
          <Text style={{ color: "#7a1a12", fontWeight: "600" }}>Error de sincronización:</Text>
          <Text style={{ color: "#7a1a12", marginTop: 4 }}>{lastError}</Text>
          <Button
            label="Forzar Sincro (Rescate)"
            onPress={handleManualForceSync}
            variant="outline"
            disabled={isSyncing}
            loading={connection === "syncing"}
            style={{ marginTop: spacing.sm }}
          />
          <Button
            label="Descartar pendientes con error"
            onPress={discardFailedItems}
            variant="outline"
            disabled={isSyncing}
            style={{ marginTop: spacing.sm }}
          />
        </Card>
      )}

      <View style={styles.quickRow}>
        <Button
          label="Nueva Preventa"
          onPress={() => {
            if (workDay.status === "closed") {
              Alert.alert(
                "Jornada Concluida",
                "La jornada de hoy ya fue concluida. ¿Deseas reabrirla para registrar una nueva preventa?",
                [
                  { text: "Cancelar", style: "cancel" },
                  {
                    text: "Reabrir Jornada",
                    onPress: async () => {
                      await handleReopen();
                      navigation.navigate("Preventa");
                    },
                  },
                ]
              );
            } else {
              navigation.navigate("Preventa");
            }
          }}
          style={{ flex: 1, marginRight: spacing.sm }}
        />
        <Button label="Nuevo Cliente" onPress={() => navigation.navigate("NuevoCliente")} variant="outline" style={{ flex: 1 }} />
      </View>
      <Button
        label="📁 Registros Históricos y Reportes"
        onPress={() => navigation.navigate("Historial")}
        variant="outline"
        style={{ marginTop: spacing.sm }}
      />

      <Text style={styles.sectionTitle}>Preventas recientes</Text>
      {workDay.status === "closed" ? (
        <Card>
          <Text style={{ color: colors.textPrimary, fontWeight: "600", fontSize: 14 }}>
            Jornada cerrada
          </Text>
          <Text style={{ color: colors.textSecondary, fontSize: 13, marginTop: 4 }}>
            Las preventas de hoy están archivadas y consolidadas en los reportes. Para ver las preventas individuales, editarlas o añadir más pedidos, presiona "Reabrir Jornada".
          </Text>
          <Button
            label="Reabrir Jornada"
            variant="secondary"
            onPress={() => Alert.alert(
              "Reabrir jornada",
              "¿Deseas volver a abrir la jornada para añadir más preventas hoy?",
              [
                { text: "Cancelar", style: "cancel" },
                { text: "Reabrir", onPress: handleReopen },
              ]
            )}
            style={{ marginTop: spacing.md }}
          />
        </Card>
      ) : recentOrders.length === 0 ? (
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
              <Button
                label="Eliminar"
                variant="danger"
                onPress={() => Alert.alert("Eliminar preventa", "¿Estás seguro de que deseas cancelar y eliminar esta preventa?", [
                  { text: "Cancelar", style: "cancel" },
                  { text: "Eliminar", style: "destructive", onPress: () => handleDeleteOrder(o.id) },
                ])}
                style={{ flex: 1 }}
              />
            </View>
          </Card>
        ))
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  rowBetween: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
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
