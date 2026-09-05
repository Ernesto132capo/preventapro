import React, { useCallback, useState } from "react";
import { View, Text, TextInput, FlatList, StyleSheet, Pressable, Alert } from "react-native";
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import { colors, spacing, radius, touchTarget } from "../theme/tokens";
import { Card } from "../components/Card";
import { StatusPill } from "../components/StatusPill";
import { EmptyState } from "../components/EmptyState";
import { Button } from "../components/Button";
import { listProducts, ProductWithPresentations, deleteProductLocal } from "../db/repositories/products";
import { centsToBs } from "../domain/pricing";

export function ProductsScreen() {
  const navigation = useNavigation<any>();
  const [products, setProducts] = useState<ProductWithPresentations[]>([]);
  const [search, setSearch] = useState("");

  const load = useCallback(async () => {
    setProducts(await listProducts(search));
  }, [search]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  function confirmDelete(p: ProductWithPresentations) {
    Alert.alert(
      "Eliminar producto",
      `¿Seguro que quieres eliminar "${p.name}"? Esta acción no se puede deshacer.`,
      [
        { text: "Cancelar", style: "cancel" },
        {
          text: "Eliminar",
          style: "destructive",
          onPress: async () => {
            await deleteProductLocal(p.id);
            load();
          },
        },
      ]
    );
  }

  return (
    <View style={styles.screen}>
      <View style={styles.headerRow}>
        <Text style={styles.title}>Catálogo de Productos</Text>
        <Button label="+ Nuevo" onPress={() => navigation.navigate("NuevoProducto")} style={styles.newBtn} />
      </View>

      <TextInput
        style={styles.search}
        placeholder="Buscar por nombre"
        placeholderTextColor={colors.textMuted}
        value={search}
        onChangeText={setSearch}
        onSubmitEditing={load}
      />

      <FlatList
        data={products}
        keyExtractor={(p) => p.id}
        contentContainerStyle={{ padding: spacing.lg, paddingTop: 0 }}
        ListEmptyComponent={<EmptyState message="No hay productos disponibles." />}
        renderItem={({ item }) => (
          <Card style={{ marginBottom: spacing.sm }}>
            <View style={styles.rowBetween}>
              <Text style={styles.productName}>{item.name}</Text>
              {item.promo_active === 1 && <StatusPill kind="pending" label="🔥 En Promoción" />}
            </View>
            {item.sync_status !== "synced" && <StatusPill kind={item.sync_status as any} />}

            <View style={styles.presWrap}>
              {item.presentations.map((p) => (
                <View key={p.id} style={styles.presRow}>
                  <Text style={styles.presName}>{p.name}</Text>
                  <Text style={styles.presStock}>Contiene {p.unit_equivalence} unidad{p.unit_equivalence === 1 ? "" : "es"}</Text>
                  <Text style={styles.presPrice}>{centsToBs(p.price_cents)}</Text>
                </View>
              ))}
            </View>

            <View style={styles.actionsRow}>
              <Pressable style={styles.actionBtn} onPress={() => navigation.navigate("NuevoProducto", { productId: item.id })}>
                <Text style={styles.actionText}>✏️ Editar</Text>
              </Pressable>
              <Pressable style={[styles.actionBtn, styles.actionBtnDanger]} onPress={() => confirmDelete(item)}>
                <Text style={[styles.actionText, { color: colors.errorText }]}>🗑️ Eliminar</Text>
              </Pressable>
            </View>
          </Card>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  headerRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", padding: spacing.lg, paddingBottom: spacing.sm },
  title: { fontSize: 18, fontWeight: "700", color: colors.textPrimary },
  newBtn: { minHeight: 40, paddingHorizontal: 14 },
  search: {
    marginHorizontal: spacing.lg,
    marginBottom: spacing.md,
    minHeight: touchTarget.min,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
    backgroundColor: colors.surface,
  },
  rowBetween: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  productName: { fontSize: 15, fontWeight: "700", color: colors.textPrimary, marginBottom: spacing.sm },
  presWrap: { borderTopWidth: 1, borderTopColor: colors.surfaceAlt3, paddingTop: spacing.sm },
  presRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 3 },
  presName: { fontSize: 13, color: colors.textPrimary, flex: 1 },
  presStock: { fontSize: 12, color: colors.textMuted, marginRight: spacing.sm },
  presPrice: { fontSize: 13, fontWeight: "600", color: colors.emeraldDark },
  actionsRow: { flexDirection: "row", flexWrap: "wrap", marginTop: spacing.md, gap: spacing.sm },
  actionBtn: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceAlt,
  },
  actionBtnDanger: { backgroundColor: colors.errorBg },
  actionText: { fontSize: 12, fontWeight: "600", color: colors.textPrimary },
});
