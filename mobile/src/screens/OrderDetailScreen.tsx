import React, { useCallback, useState } from "react";
import { Alert, ScrollView, StyleSheet, Text, View } from "react-native";
import { useFocusEffect, useNavigation, useRoute } from "@react-navigation/native";
import { Button } from "../components/Button";
import { Card } from "../components/Card";
import { getOrderWithItems, cancelOrderLocal } from "../db/repositories/orders";
import { centsToBs } from "../domain/pricing";
import { colors, spacing } from "../theme/tokens";
import { useSync } from "../context/SyncContext";

export function OrderDetailScreen() {
  const navigation = useNavigation<any>();
  const route = useRoute<any>();
  const { forceSync } = useSync();
  const [data, setData] = useState<{ order: any; items: any[] } | null>(null);

  const load = useCallback(async () => setData(await getOrderWithItems(route.params.orderId)), [route.params.orderId]);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  async function remove() {
    await cancelOrderLocal(route.params.orderId);
    await forceSync();
    navigation.goBack();
  }

  if (!data?.order) return null;
  const { order, items } = data;
  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Card>
        <Text style={styles.client}>{order.client_name}</Text>
        <Text style={styles.meta}>Creada: {new Date(order.created_at).toLocaleString("es-BO")}</Text>
        <Text style={styles.meta}>Condición: {order.payment_condition}</Text>
      </Card>
      <Text style={styles.heading}>Productos</Text>
      {items.map((item) => (
        <Card key={item.id} style={{ marginBottom: spacing.sm }}>
          <View style={styles.row}><Text style={styles.product}>{item.product_name_snapshot}</Text><Text style={styles.amount}>{centsToBs(item.subtotal_cents)}</Text></View>
          <Text style={styles.meta}>{item.presentation_name_snapshot} · Cantidad: {item.quantity}</Text>
        </Card>
      ))}
      <Card style={styles.totalCard}><Text style={styles.total}>Total: {centsToBs(order.total_cents)}</Text></Card>
      <View style={styles.actions}>
        <Button label="Editar" onPress={() => navigation.navigate("EditarPreventa", { orderId: order.id })} style={{ flex: 1 }} />
        <Button label="Eliminar" variant="danger" onPress={() => Alert.alert("Eliminar preventa", "La preventa se cancelará.", [{ text: "Cancelar", style: "cancel" }, { text: "Eliminar", style: "destructive", onPress: remove }])} style={{ flex: 1 }} />
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg }, content: { padding: spacing.lg },
  client: { fontSize: 18, fontWeight: "700", color: colors.textPrimary },
  heading: { marginTop: spacing.lg, marginBottom: spacing.sm, fontWeight: "700", color: colors.textPrimary },
  row: { flexDirection: "row", justifyContent: "space-between" }, product: { fontWeight: "600", color: colors.textPrimary },
  amount: { fontWeight: "700", color: colors.emeraldDark }, meta: { marginTop: 4, fontSize: 12, color: colors.textSecondary },
  totalCard: { marginTop: spacing.sm }, total: { fontSize: 18, fontWeight: "700", color: colors.textPrimary },
  actions: { flexDirection: "row", gap: spacing.sm, marginTop: spacing.lg },
});
