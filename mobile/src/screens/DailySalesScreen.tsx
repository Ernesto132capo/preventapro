import React, { useCallback, useEffect, useState } from "react";
import { View, Text, FlatList, StyleSheet, TextInput, Alert } from "react-native";
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import { colors, spacing, radius } from "../theme/tokens";
import { Card } from "../components/Card";
import { StatusPill } from "../components/StatusPill";
import { Button } from "../components/Button";
import { EmptyState } from "../components/EmptyState";
import { useAuth } from "../context/AuthContext";
import { useSync } from "../context/SyncContext";
import { getOrCreateOpenWorkDay, resolveServerWorkDayId, markWorkDayClosed, upsertServerWorkDay, reopenWorkDayLocal } from "../db/repositories/workdays";
import { listOrdersForWorkDay, countUnsyncedOrders } from "../db/repositories/orders";
import { centsToBs } from "../domain/pricing";
import { LocalOrder, WorkDay } from "../domain/types";
import { apiFetch, ApiError } from "../services/api";

export function DailySalesScreen() {
  const { user } = useAuth();
  const { forceSync, connection, syncTick } = useSync();
  const navigation = useNavigation<any>();

  const [workDay, setWorkDay] = useState<WorkDay | null>(null);
  const [orders, setOrders] = useState<LocalOrder[]>([]);
  const [showCloseForm, setShowCloseForm] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [closing, setClosing] = useState(false);
  const [reopening, setReopening] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!user) return;
    const wd = await getOrCreateOpenWorkDay(user.id);
    const ords = await listOrdersForWorkDay(wd.id);
    setOrders(ords);
    const totalCents = ords.reduce((sum, o) => sum + (o.total_cents || 0), 0);
    const orderCount = ords.length;
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
    // Comprobar y sincronizar cambios pendientes antes de cerrar (Fase 27)
    await forceSync();
    const pending = await countUnsyncedOrders(workDay.id);
    if (pending > 0) {
      setClosing(false);
      setError(`Aún hay ${pending} preventa(s) sin sincronizar. Verifica tu conexión e intenta de nuevo.`);
      return;
    }

    const serverId = await resolveServerWorkDayId(workDay.id);
    if (!serverId) {
      setClosing(false);
      setError("No se pudo confirmar la jornada con el servidor. Verifica tu conexión.");
      return;
    }

    try {
      const res = await apiFetch<any>(`/workdays/${serverId}/close`, {
        method: "POST",
        body: { confirmation: confirmText },
      });
      await markWorkDayClosed(workDay.id, res.workDay.order_count, res.workDay.total_cents);
      await upsertServerWorkDay(workDay.id, res.workDay);
      setClosing(false);
      setShowCloseForm(false);
      Alert.alert(
        "Jornada concluida",
        `Total final del día: ${centsToBs(res.workDay.total_cents)}. Preventas concluidas: ${res.workDay.order_count}.`
      );
      await forceSync();
      await load();
    } catch (err) {
      setClosing(false);
      setError(err instanceof ApiError ? err.message : "No se pudo cerrar la jornada.");
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

      {workDay.status === "closed" ? (
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
          renderItem={({ item }) => (
            <Card style={{ marginBottom: spacing.sm }}>
              <View style={styles.rowBetween}>
                <Text style={styles.orderClient}>{item.client_name}</Text>
                <StatusPill
                  kind={item.sync_status === "synced" ? "synced" : item.sync_status === "failed" ? "failed" : "pending"}
                />
              </View>
              <Text style={styles.orderMeta}>{item.item_count} items · {new Date(item.created_at).toLocaleTimeString("es-BO", { hour: "2-digit", minute: "2-digit" })}</Text>
              <Text style={styles.orderTotal}>{centsToBs(item.total_cents)}</Text>
            </Card>
          )}
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
  orderMeta: { fontSize: 12, color: colors.textMuted, marginTop: 2 },
  orderTotal: { fontSize: 15, fontWeight: "700", color: colors.emeraldDark, marginTop: 4 },
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
