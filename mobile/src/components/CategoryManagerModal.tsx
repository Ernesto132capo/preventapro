import React, { useEffect, useState } from "react";
import { View, Text, TextInput, Modal, StyleSheet, FlatList, Pressable, Alert } from "react-native";
import { colors, spacing, radius, touchTarget } from "../theme/tokens";
import { Button } from "./Button";
import { Card } from "./Card";
import { Category } from "../domain/types";
import { listCategories, createCategoryLocal } from "../db/repositories/categories";
import { useSync } from "../context/SyncContext";

interface Props {
  visible: boolean;
  selectedCategoryId?: string | null;
  onSelect: (category: Category | null) => void;
  onClose: () => void;
}

export function CategoryManagerModal({ visible, selectedCategoryId, onSelect, onClose }: Props) {
  const { pushSync } = useSync();
  const [categories, setCategories] = useState<Category[]>([]);
  const [search, setSearch] = useState("");
  const [newCatName, setNewCatName] = useState("");
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (visible) {
      load();
    }
  }, [visible]);

  async function load() {
    const list = await listCategories();
    setCategories(list);
  }

  async function handleCreate() {
    const name = newCatName.trim();
    if (!name) return;
    setCreating(true);
    try {
      const cat = await createCategoryLocal(name);
      await pushSync();
      setNewCatName("");
      await load();
      onSelect(cat);
      onClose();
    } catch (e: any) {
      Alert.alert("Error", e?.message || "No se pudo crear la categoría.");
    } finally {
      setCreating(false);
    }
  }

  const filtered = categories.filter((c) =>
    c.name.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.container}>
          <View style={styles.header}>
            <Text style={styles.title}>Seleccionar Categoría</Text>
            <Pressable onPress={onClose} style={styles.closeBtn}>
              <Text style={styles.closeBtnText}>✕</Text>
            </Pressable>
          </View>

          <TextInput
            style={styles.input}
            placeholder="Buscar categoría..."
            placeholderTextColor={colors.textMuted}
            value={search}
            onChangeText={setSearch}
          />

          <View style={styles.createRow}>
            <TextInput
              style={[styles.input, { flex: 1, marginBottom: 0 }]}
              placeholder="Nueva categoría..."
              placeholderTextColor={colors.textMuted}
              value={newCatName}
              onChangeText={setNewCatName}
            />
            <Button
              label="Crear"
              onPress={handleCreate}
              loading={creating}
              style={{ marginLeft: spacing.sm, minHeight: touchTarget.min }}
            />
          </View>

          <FlatList
            data={filtered}
            keyExtractor={(c) => c.id}
            style={{ maxHeight: 300, marginVertical: spacing.md }}
            ListHeaderComponent={
              <Pressable
                style={[styles.catItem, !selectedCategoryId && styles.catItemActive]}
                onPress={() => {
                  onSelect(null);
                  onClose();
                }}
              >
                <Text style={[styles.catItemText, !selectedCategoryId && styles.catItemTextActive]}>
                  (Sin categoría)
                </Text>
              </Pressable>
            }
            renderItem={({ item }) => {
              const isSelected = Boolean(
                selectedCategoryId &&
                  (selectedCategoryId === item.id ||
                    (item.server_id && selectedCategoryId === item.server_id) ||
                    selectedCategoryId.toLowerCase() === item.name.toLowerCase())
              );
              return (
                <Pressable
                  style={[styles.catItem, isSelected && styles.catItemActive]}
                  onPress={() => {
                    onSelect(item);
                    onClose();
                  }}
                >
                  <Text style={[styles.catItemText, isSelected && styles.catItemTextActive]}>
                    {item.name}
                  </Text>
                </Pressable>
              );
            }}
          />

          <Button label="Cerrar" variant="outline" onPress={onClose} />
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.5)",
    justifyContent: "center",
    padding: spacing.lg,
  },
  container: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: spacing.lg,
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: spacing.md,
  },
  title: { fontSize: 18, fontWeight: "700", color: colors.textPrimary },
  closeBtn: { padding: spacing.xs },
  closeBtnText: { fontSize: 18, color: colors.textMuted },
  input: {
    minHeight: touchTarget.min,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    backgroundColor: colors.surfaceAlt,
    fontSize: 14,
    color: colors.textPrimary,
    marginBottom: spacing.sm,
  },
  createRow: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: spacing.sm,
  },
  catItem: {
    paddingVertical: 12,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    marginBottom: 4,
    backgroundColor: colors.surfaceAlt,
  },
  catItemActive: {
    backgroundColor: colors.emerald,
  },
  catItemText: {
    fontSize: 14,
    fontWeight: "600",
    color: colors.textPrimary,
  },
  catItemTextActive: {
    color: "#fff",
  },
});
