import React, { useCallback, useRef, useState } from "react";
import { Alert, ScrollView, StyleSheet, Text, View } from "react-native";
import { useFocusEffect, useNavigation, useRoute } from "@react-navigation/native";
import { Button } from "../components/Button";
import { Card } from "../components/Card";
import { getOrderWithItems, cancelOrderLocal } from "../db/repositories/orders";
import { getTodayWorkDay } from "../db/repositories/workdays";
import { getDb } from "../db/client";
import { centsToBs } from "../domain/pricing";
import { formatClientDisplayName } from "../domain/client-display";
import { colors, radius, spacing } from "../theme/tokens";
import { useSync } from "../context/SyncContext";
import { useAuth } from "../context/AuthContext";

export function OrderDetailScreen() {
  const navigation = useNavigation<any>();
  const route = useRoute<any>();
  const { forceSync } = useSync();
  const { user } = useAuth();
  const [data, setData] = useState<{ order: any; items: any[] } | null>(null);
  const [orderWorkDay, setOrderWorkDay] = useState<{ id: string; status: string; work_date: string } | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const isSubmittingRef = useRef(false);

  const load = useCallback(async () => {
    const orderData = await getOrderWithItems(route.params.orderId);
    if (orderData?.order) {
      const db = await getDb();
      const wd = await db.getFirstAsync<{ id: string; status: string; work_date: string }>(
        `SELECT id, status, work_date FROM work_days WHERE id = ? OR server_id = ?`,
        [orderData.order.work_day_id, orderData.order.work_day_id]
      );
      setOrderWorkDay(wd || null);
    }
    setData(orderData);
  }, [route.params.orderId]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  async function verifyWorkdayOpen(): Promise<boolean> {
    if (orderWorkDay?.status === "closed") {
      Alert.alert(
        "Jornada Concluida",
        "La jornada de esta preventa está cerrada. Para modificarla o eliminarla debes reabrir la jornada desde el Inicio."
      );
      return false;
    }
    if (user) {
      const todayWd = await getTodayWorkDay(user.id);
      if (todayWd.status === "closed") {
        Alert.alert(
          "Jornada Concluida",
          "La jornada de hoy está cerrada. Debes reabrir la jornada desde el Inicio para poder modificar o eliminar preventas."
        );
        return false;
      }
    }
    return true;
  }

  async function handleEdit() {
    if (isSubmittingRef.current || isSubmitting) return;
    if (!data?.order) return;
    if (data.order.status === "cancelled") {
      Alert.alert("Preventa Anulada", "Esta preventa ya se encuentra anulada y no puede ser editada.");
      return;
    }
    const canProceed = await verifyWorkdayOpen();
    if (!canProceed) return;

    navigation.navigate("EditarPreventa", { orderId: data.order.id });
  }

  async function remove() {
    if (isSubmittingRef.current || isSubmitting) return;
    if (!data?.order) return;
    if (data.order.status === "cancelled") {
      Alert.alert("Preventa Anulada", "Esta preventa ya se encuentra anulada.");
      return;
    }
    const canProceed = await verifyWorkdayOpen();
    if (!canProceed) return;

    isSubmittingRef.current = true;
    setIsSubmitting(true);
    try {
      await cancelOrderLocal(data.order.id);
      void forceSync().catch(() => {});
      navigation.goBack();
    } catch (err: any) {
      Alert.alert("No se pudo eliminar", err?.message || "Ocurrió un problema al eliminar la preventa localmente.");
    } finally {
      isSubmittingRef.current = false;
      setIsSubmitting(false);
    }
  }

  if (!data?.order) return null;
  const { order, items } = data;
  const isCancelled = order.status === "cancelled";
  const isWorkdayClosed = orderWorkDay?.status === "closed";
  const clientDisplay = formatClientDisplayName({
    business_name: order.business_name || order.client_name,
    contact_name: order.contact_name,
  });

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Card>
        <View style={styles.row}>
          <View style={{ flex: 1, marginRight: spacing.sm }}>
            <Text style={styles.client}>{clientDisplay.primary}</Text>
            {!!clientDisplay.secondary && <Text style={styles.clientOwnerSub}>{clientDisplay.secondary}</Text>}
          </View>
          {isCancelled && (
            <View style={styles.cancelledBadge}>
              <Text style={styles.cancelledBadgeText}>❌ Anulada</Text>
            </View>
          )}
        </View>
        <Text style={styles.meta}>Creada: {new Date(order.created_at).toLocaleString("es-BO")}</Text>
        <Text style={styles.meta}>Condición: {order.payment_condition}</Text>
        {isWorkdayClosed && !isCancelled && (
          <View style={styles.closedBanner}>
            <Text style={styles.closedBannerText}>🔒 Jornada concluida (solo lectura)</Text>
          </View>
        )}
      </Card>
      <Text style={styles.heading}>Productos</Text>
      {items.map((item) => {
        const hasSelections = item.selections && item.selections.length > 0;
        return (
          <Card key={item.id} style={{ marginBottom: spacing.sm }}>
            <View style={styles.row}>
              <View style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: 6 }}>
                <Text style={styles.product}>{item.product_name_snapshot}</Text>
                {hasSelections && (
                  <View style={styles.comboBadge}>
                    <Text style={styles.comboBadgeText}>🎁 Combo</Text>
                  </View>
                )}
              </View>
              <Text style={styles.amount}>{centsToBs(item.subtotal_cents)}</Text>
            </View>
            <Text style={styles.meta}>{item.presentation_name_snapshot} · Cantidad: {item.quantity}</Text>
            {hasSelections && (
              <View style={styles.selectionsBox}>
                <Text style={styles.selectionsTitle}>Opciones elegidas:</Text>
                {item.selections.map((sel: any, sIdx: number) => (
                  <Text key={sel.id || sIdx} style={styles.selectionItem}>
                    • {sel.quantity} × {sel.product_name_snapshot} ({sel.presentation_name_snapshot})
                  </Text>
                ))}
              </View>
            )}
          </Card>
        );
      })}
      <Card style={styles.totalCard}><Text style={styles.total}>Total: {centsToBs(order.total_cents)}</Text></Card>
      {!isCancelled && (
        <View style={styles.actions}>
          <Button
            label="Editar"
            onPress={handleEdit}
            disabled={isSubmitting || isWorkdayClosed}
            style={{ flex: 1 }}
          />
          <Button
            label="Eliminar"
            variant="danger"
            disabled={isSubmitting || isWorkdayClosed}
            loading={isSubmitting}
            onPress={() =>
              Alert.alert(
                "Eliminar preventa",
                "La preventa se cancelará y no se sumará a los totales del día.",
                [
                  { text: "Cancelar", style: "cancel" },
                  { text: "Eliminar", style: "destructive", onPress: remove },
                ]
              )
            }
            style={{ flex: 1 }}
          />
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.lg },
  client: { fontSize: 18, fontWeight: "700", color: colors.textPrimary },
  clientOwnerSub: { fontSize: 14, color: colors.textSecondary, marginTop: 2 },
  heading: { marginTop: spacing.lg, marginBottom: spacing.sm, fontWeight: "700", color: colors.textPrimary },
  row: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  product: { fontWeight: "600", color: colors.textPrimary },
  comboBadge: {
    backgroundColor: "#ede9fe",
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: radius.pill,
  },
  comboBadgeText: {
    fontSize: 10,
    fontWeight: "700",
    color: "#6d28d9",
  },
  amount: { fontWeight: "700", color: colors.emeraldDark },
  meta: { marginTop: 4, fontSize: 12, color: colors.textSecondary },
  selectionsBox: {
    backgroundColor: colors.surfaceAlt,
    padding: spacing.xs,
    borderRadius: radius.sm,
    marginTop: spacing.xs,
  },
  selectionsTitle: {
    fontSize: 11,
    fontWeight: "700",
    color: colors.textPrimary,
    marginBottom: 2,
  },
  selectionItem: {
    fontSize: 11,
    color: colors.textSecondary,
    lineHeight: 15,
  },
  totalCard: { marginTop: spacing.sm },
  total: { fontSize: 18, fontWeight: "700", color: colors.textPrimary },
  actions: { flexDirection: "row", gap: spacing.sm, marginTop: spacing.lg },
  cancelledBadge: {
    backgroundColor: colors.errorBg,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: radius.pill,
  },
  cancelledBadgeText: {
    color: colors.errorText,
    fontSize: 11,
    fontWeight: "700",
  },
  closedBanner: {
    backgroundColor: colors.amberBg,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: radius.sm,
    marginTop: spacing.sm,
  },
  closedBannerText: {
    color: colors.amberText,
    fontSize: 12,
    fontWeight: "600",
  },
});
