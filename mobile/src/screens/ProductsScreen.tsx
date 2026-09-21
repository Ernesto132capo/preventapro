import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { View, Text, TextInput, FlatList, StyleSheet, Pressable, Alert, ScrollView } from "react-native";
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import { colors, spacing, radius, touchTarget } from "../theme/tokens";
import { Card } from "../components/Card";
import { StatusPill } from "../components/StatusPill";
import { EmptyState } from "../components/EmptyState";
import { Button } from "../components/Button";
import { listProducts, ProductWithPresentations, deleteProductLocal, toggleFavoriteLocal } from "../db/repositories/products";
import { listCategories } from "../db/repositories/categories";
import { Category } from "../domain/types";
import { centsToBs } from "../domain/pricing";
import { useSync } from "../context/SyncContext";
import { useDebounce } from "../utils/useDebounce";

export function ProductsScreen() {
  const navigation = useNavigation<any>();
  const { syncTick } = useSync();
  const [products, setProducts] = useState<ProductWithPresentations[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(null);
  const [showOnlyFavorites, setShowOnlyFavorites] = useState(false);
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebounce(search, 300);

  const load = useCallback(async () => {
    const [prods, cats] = await Promise.all([
      listProducts({ search: debouncedSearch }),
      listCategories(),
    ]);
    setProducts(prods);
    setCategories(cats);
  }, [debouncedSearch]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  useEffect(() => {
    if (syncTick > 0) load();
  }, [syncTick]);

  const categoryMap = useMemo(() => {
    const map = new Map<string, string>();
    categories.forEach((c) => {
      map.set(c.id, c.name);
      if (c.server_id) map.set(c.server_id, c.name);
    });
    return map;
  }, [categories]);

  const filteredProducts = useMemo(() => {
    let list = products;
    if (showOnlyFavorites) {
      list = list.filter((p) => p.is_favorite);
    }
    if (selectedCategoryId) {
      list = list.filter((p) => p.category_id === selectedCategoryId || (categoryMap.has(p.category_id || "") && selectedCategoryId === p.category_id));
    }
    return list;
  }, [products, showOnlyFavorites, selectedCategoryId, categoryMap]);

  const handleToggleFavorite = useCallback(async (productId: string) => {
    const nowFav = await toggleFavoriteLocal(productId);
    setProducts((prev) =>
      prev.map((p) => (p.id === productId ? { ...p, is_favorite: nowFav } : p))
    );
  }, []);

  const confirmDelete = useCallback((p: ProductWithPresentations) => {
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
  }, [load]);

  const renderProductItem = useCallback(
    ({ item }: { item: ProductWithPresentations }) => (
      <ProductCardItem
        item={item}
        categoryName={item.category_id ? categoryMap.get(item.category_id) || null : null}
        onToggleFavorite={handleToggleFavorite}
        onEdit={() => navigation.navigate("NuevoProducto", { productId: item.id })}
        onDelete={() => confirmDelete(item)}
      />
    ),
    [categoryMap, handleToggleFavorite, navigation, confirmDelete]
  );

  const favoriteCount = useMemo(() => products.filter((p) => p.is_favorite).length, [products]);

  return (
    <View style={styles.screen}>
      <View style={styles.headerRow}>
        <Text style={styles.title}>Catálogo de Productos</Text>
        <Button label="+ Nuevo" onPress={() => navigation.navigate("NuevoProducto")} style={styles.newBtn} />
      </View>

      <TextInput
        style={styles.search}
        placeholder="Buscar por nombre o SKU..."
        placeholderTextColor={colors.textMuted}
        value={search}
        onChangeText={setSearch}
      />

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.categoriesBar}
      >
        <Pressable
          style={[styles.categoryChip, !selectedCategoryId && !showOnlyFavorites && styles.categoryChipActive]}
          onPress={() => {
            setSelectedCategoryId(null);
            setShowOnlyFavorites(false);
          }}
        >
          <Text style={[styles.categoryChipText, !selectedCategoryId && !showOnlyFavorites && styles.categoryChipTextActive]}>
            Todos ({products.length})
          </Text>
        </Pressable>

        <Pressable
          style={[styles.categoryChip, showOnlyFavorites && styles.categoryChipFavoriteActive]}
          onPress={() => {
            setShowOnlyFavorites((prev) => !prev);
            setSelectedCategoryId(null);
          }}
        >
          <Text style={[styles.categoryChipText, showOnlyFavorites && styles.categoryChipTextActive]}>
            ⭐ Favoritos ({favoriteCount})
          </Text>
        </Pressable>

        {categories.map((cat) => {
          const count = products.filter((p) => p.category_id === cat.id || (cat.server_id && p.category_id === cat.server_id)).length;
          const active = selectedCategoryId === cat.id && !showOnlyFavorites;
          return (
            <Pressable
              key={cat.id}
              style={[styles.categoryChip, active && styles.categoryChipActive]}
              onPress={() => {
                setShowOnlyFavorites(false);
                setSelectedCategoryId(active ? null : cat.id);
              }}
            >
              <Text style={[styles.categoryChipText, active && styles.categoryChipTextActive]}>
                {cat.name} ({count})
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>

      <FlatList
        data={filteredProducts}
        keyExtractor={(p, idx) => `${p.id}-${idx}`}
        renderItem={renderProductItem}
        contentContainerStyle={{ padding: spacing.lg, paddingTop: 0 }}
        ListEmptyComponent={<EmptyState message="No hay productos disponibles." />}
        initialNumToRender={8}
        maxToRenderPerBatch={10}
        windowSize={5}
        removeClippedSubviews={true}
      />
    </View>
  );
}

const ProductCardItem = React.memo(function ProductCardItem({
  item,
  categoryName,
  onToggleFavorite,
  onEdit,
  onDelete,
}: {
  item: ProductWithPresentations;
  categoryName: string | null;
  onToggleFavorite: (id: string) => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const isCombo = item.product_type === "combo";
  const comboDef = item.combo_definition;

  return (
    <Card style={{ marginBottom: spacing.sm }}>
      <View style={styles.rowBetween}>
        <View style={{ flex: 1, marginRight: spacing.sm }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <Text style={styles.productName}>{item.name}</Text>
          </View>
          {categoryName && <Text style={styles.categoryLabel}>📁 {categoryName}</Text>}
        </View>
        <View style={styles.badgeRow}>
          <Pressable onPress={() => onToggleFavorite(item.id)} style={styles.starBtn}>
            <Text style={{ fontSize: 18 }}>{item.is_favorite ? "⭐" : "☆"}</Text>
          </Pressable>
          {isCombo && (
            <View style={styles.comboBadge}>
              <Text style={styles.comboBadgeText}>🎁 Combo</Text>
            </View>
          )}
          {item.promo_active === 1 && <StatusPill kind="pending" label="🔥 Promo" />}
        </View>
      </View>

      {isCombo && comboDef && (
        <View style={styles.comboInfoBox}>
          <Text style={styles.comboInfoTitle}>
            ⚙️ Regla: {comboDef.selection_min === comboDef.selection_max
              ? `Elegir exactamente ${comboDef.selection_min} unidades`
              : `Elegir de ${comboDef.selection_min} a ${comboDef.selection_max} unidades`}
          </Text>
          <Text style={styles.comboInfoSubtitle}>
            {comboDef.options?.length || 0} productos/opciones disponibles
          </Text>
        </View>
      )}

      {item.sync_status !== "synced" && (
        <View style={{ marginTop: spacing.xs }}>
          <StatusPill kind={item.sync_status as any} />
        </View>
      )}

      <View style={styles.presWrap}>
        {item.presentations.map((p) => (
          <View key={p.id} style={styles.presRow}>
            <Text style={styles.presName}>{p.name}</Text>
            <Text style={styles.presEquiv}>
              Contiene {p.unit_equivalence} unidad{p.unit_equivalence === 1 ? "" : "es"}
            </Text>
            <Text style={styles.presPrice}>{centsToBs(p.price_cents)}</Text>
          </View>
        ))}
      </View>

      <View style={styles.actionsRow}>
        <Pressable style={styles.actionBtn} onPress={onEdit}>
          <Text style={styles.actionText}>✏️ Editar</Text>
        </Pressable>
        <Pressable style={[styles.actionBtn, styles.actionBtnDanger]} onPress={onDelete}>
          <Text style={[styles.actionText, { color: colors.errorText }]}>🗑️ Eliminar</Text>
        </Pressable>
      </View>
    </Card>
  );
});

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  headerRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", padding: spacing.lg, paddingBottom: spacing.sm },
  title: { fontSize: 18, fontWeight: "700", color: colors.textPrimary },
  newBtn: { minHeight: 40, paddingHorizontal: 14 },
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
  categoriesBar: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    gap: spacing.xs,
  },
  categoryChip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.border,
    marginRight: spacing.xs,
  },
  categoryChipActive: {
    backgroundColor: colors.navy,
    borderColor: colors.navy,
  },
  categoryChipFavoriteActive: {
    backgroundColor: "#b45309",
    borderColor: "#b45309",
  },
  categoryChipText: {
    fontSize: 12,
    fontWeight: "600",
    color: colors.textSecondary,
  },
  categoryChipTextActive: {
    color: "#fff",
  },
  rowBetween: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start" },
  badgeRow: { flexDirection: "row", gap: 6, alignItems: "center" },
  starBtn: { padding: 2 },
  comboBadge: {
    backgroundColor: "#ede9fe",
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: radius.pill,
  },
  comboBadgeText: {
    fontSize: 11,
    fontWeight: "700",
    color: "#6d28d9",
  },
  productName: { fontSize: 15, fontWeight: "700", color: colors.textPrimary },
  categoryLabel: { fontSize: 12, color: colors.textSecondary, marginTop: 2, marginBottom: spacing.xs },
  comboInfoBox: {
    backgroundColor: colors.surfaceAlt,
    padding: spacing.xs,
    borderRadius: radius.sm,
    marginVertical: spacing.xs,
  },
  comboInfoTitle: { fontSize: 12, fontWeight: "600", color: colors.textPrimary },
  comboInfoSubtitle: { fontSize: 11, color: colors.textMuted, marginTop: 2 },
  presWrap: { borderTopWidth: 1, borderTopColor: colors.surfaceAlt3, paddingTop: spacing.sm, marginTop: spacing.xs },
  presRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 3 },
  presName: { fontSize: 13, color: colors.textPrimary, flex: 1 },
  presEquiv: { fontSize: 12, color: colors.textMuted, marginRight: spacing.sm },
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
