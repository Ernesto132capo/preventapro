import React, { useEffect, useState, useRef } from "react";
import { View, Text, TextInput, Modal, StyleSheet, FlatList, Pressable, Alert } from "react-native";
import { colors, spacing, radius, touchTarget } from "../theme/tokens";
import { Button } from "./Button";
import { Category } from "../domain/types";
import {
  listCategories,
  createCategoryLocal,
  updateCategoryLocal,
  deleteCategoryLocal,
} from "../db/repositories/categories";
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
  const [submitting, setSubmitting] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const isSubmittingRef = useRef(false);

  useEffect(() => {
    if (visible) {
      setEditingId(null);
      setEditingName("");
      load();
    }
  }, [visible]);

  async function load() {
    const list = await listCategories();
    setCategories(list);
  }

  async function handleCreate() {
    if (isSubmittingRef.current || creating || submitting) return;
    const name = newCatName.trim();
    if (!name) return;

    isSubmittingRef.current = true;
    setCreating(true);
    setSubmitting(true);
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
      isSubmittingRef.current = false;
      setCreating(false);
      setSubmitting(false);
    }
  }

  async function handleSaveEdit(id: string) {
    if (isSubmittingRef.current || submitting) return;
    const name = editingName.trim();
    if (!name) {
      Alert.alert("Dato requerido", "El nombre de la categoría no puede estar vacío.");
      return;
    }

    isSubmittingRef.current = true;
    setSubmitting(true);
    try {
      const updated = await updateCategoryLocal(id, name);
      await pushSync();
      setEditingId(null);
      setEditingName("");
      await load();
      if (
        selectedCategoryId === id ||
        (updated.server_id && selectedCategoryId === updated.server_id)
      ) {
        onSelect(updated);
      }
    } catch (e: any) {
      Alert.alert("Error", e?.message || "No se pudo actualizar la categoría.");
    } finally {
      isSubmittingRef.current = false;
      setSubmitting(false);
    }
  }

  function handleDeleteCategory(item: Category) {
    if (isSubmittingRef.current || submitting) return;
    Alert.alert(
      "Eliminar categoría",
      `¿Seguro que deseas eliminar la categoría "${item.name}"? Los productos asociados quedarán sin categoría.`,
      [
        { text: "Cancelar", style: "cancel" },
        {
          text: "Eliminar",
          style: "destructive",
          onPress: async () => {
            if (isSubmittingRef.current || submitting) return;
            isSubmittingRef.current = true;
            setSubmitting(true);
            try {
              await deleteCategoryLocal(item.id);
              await pushSync();
              await load();
              if (
                selectedCategoryId === item.id ||
                (item.server_id && selectedCategoryId === item.server_id)
              ) {
                onSelect(null);
              }
            } catch (e: any) {
              Alert.alert("Error", e?.message || "No se pudo eliminar la categoría.");
            } finally {
              isSubmittingRef.current = false;
              setSubmitting(false);
            }
          },
        },
      ]
    );
  }

  const filtered = categories.filter((c) =>
    c.name.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.container}>
          <View style={styles.header}>
            <Text style={styles.title}>Administrar Categorías</Text>
            <Pressable onPress={onClose} style={styles.closeBtn} disabled={submitting}>
              <Text style={styles.closeBtnText}>✕</Text>
            </Pressable>
          </View>

          <TextInput
            style={styles.input}
            placeholder="Buscar categoría..."
            placeholderTextColor={colors.textMuted}
            value={search}
            onChangeText={setSearch}
            editable={!submitting}
          />

          <View style={styles.createRow}>
            <TextInput
              style={[styles.input, { flex: 1, marginBottom: 0 }]}
              placeholder="Nueva categoría..."
              placeholderTextColor={colors.textMuted}
              value={newCatName}
              onChangeText={setNewCatName}
              editable={!submitting}
            />
            <Button
              label="Crear"
              onPress={handleCreate}
              loading={creating}
              disabled={submitting}
              style={{ marginLeft: spacing.sm, minHeight: touchTarget.min }}
            />
          </View>

          <FlatList
            data={filtered}
            keyExtractor={(c) => c.id}
            keyboardShouldPersistTaps="handled"
            style={{ maxHeight: 300, marginVertical: spacing.md }}
            ListHeaderComponent={
              <Pressable
                style={[styles.catItem, !selectedCategoryId && styles.catItemActive]}
                onPress={() => {
                  if (submitting) return;
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

              if (editingId === item.id) {
                return (
                  <View style={styles.editRow}>
                    <TextInput
                      style={[styles.input, { flex: 1, marginBottom: 0 }]}
                      value={editingName}
                      onChangeText={setEditingName}
                      placeholder="Nombre..."
                      placeholderTextColor={colors.textMuted}
                      autoFocus
                      editable={!submitting}
                    />
                    <Pressable
                      style={[styles.smallBtn, styles.saveBtn, submitting && styles.btnDisabled]}
                      onPress={() => handleSaveEdit(item.id)}
                      disabled={submitting}
                    >
                      <Text style={styles.saveBtnText}>✓</Text>
                    </Pressable>
                    <Pressable
                      style={[styles.smallBtn, styles.cancelBtn]}
                      onPress={() => {
                        setEditingId(null);
                        setEditingName("");
                      }}
                      disabled={submitting}
                    >
                      <Text style={styles.cancelBtnText}>✕</Text>
                    </Pressable>
                  </View>
                );
              }

              return (
                <View style={[styles.catRow, isSelected && styles.catItemActive]}>
                  <Pressable
                    style={styles.catSelectArea}
                    onPress={() => {
                      if (submitting) return;
                      onSelect(item);
                      onClose();
                    }}
                  >
                    <Text style={[styles.catItemText, isSelected && styles.catItemTextActive]}>
                      {item.name}
                    </Text>
                  </Pressable>
                  <View style={styles.catActions}>
                    <Pressable
                      style={styles.actionBtn}
                      onPress={() => {
                        if (submitting) return;
                        setEditingId(item.id);
                        setEditingName(item.name);
                      }}
                      disabled={submitting}
                    >
                      <Text style={styles.actionIcon}>✏️</Text>
                    </Pressable>
                    <Pressable
                      style={styles.actionBtn}
                      onPress={() => handleDeleteCategory(item)}
                      disabled={submitting}
                    >
                      <Text style={styles.actionIcon}>🗑️</Text>
                    </Pressable>
                  </View>
                </View>
              );
            }}
          />

          <Button label="Cerrar" variant="outline" onPress={onClose} disabled={submitting} />
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
  closeBtn: { padding: spacing.xs, minHeight: 32, minWidth: 32, justifyContent: "center", alignItems: "center" },
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
  catRow: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: radius.md,
    marginBottom: 4,
    backgroundColor: colors.surfaceAlt,
  },
  catSelectArea: {
    flex: 1,
    paddingVertical: 12,
    paddingHorizontal: spacing.md,
  },
  catActions: {
    flexDirection: "row",
    alignItems: "center",
    paddingRight: spacing.sm,
  },
  actionBtn: {
    padding: spacing.sm,
    minHeight: 36,
    minWidth: 36,
    alignItems: "center",
    justifyContent: "center",
  },
  actionIcon: {
    fontSize: 14,
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
  editRow: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 4,
    gap: spacing.xs,
  },
  smallBtn: {
    minHeight: touchTarget.min,
    minWidth: 44,
    borderRadius: radius.md,
    alignItems: "center",
    justifyContent: "center",
  },
  saveBtn: {
    backgroundColor: colors.emerald,
  },
  saveBtnText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "700",
  },
  cancelBtn: {
    backgroundColor: colors.surfaceAlt2,
    borderWidth: 1,
    borderColor: colors.border,
  },
  cancelBtnText: {
    color: colors.textSecondary,
    fontSize: 14,
    fontWeight: "600",
  },
  btnDisabled: {
    opacity: 0.6,
  },
});
