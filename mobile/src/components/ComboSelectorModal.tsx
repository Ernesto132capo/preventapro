import React, { useState } from "react";
import { View, Text, TextInput, Modal, StyleSheet, FlatList, Pressable, Alert } from "react-native";
import { colors, spacing, radius, touchTarget } from "../theme/tokens";
import { Button } from "./Button";
import { Card } from "./Card";
import { ProductWithPresentations } from "../db/repositories/products";
import { Presentation, CartLineSelection, ComboOption } from "../domain/types";
import { centsToBs } from "../domain/pricing";
import { useDebounce } from "../utils/useDebounce";

interface Props {
  visible: boolean;
  product: ProductWithPresentations | null;
  presentation: Presentation | null;
  onAdd: (product: ProductWithPresentations, presentation: Presentation, quantity: number, selections: CartLineSelection[]) => void;
  onClose: () => void;
}

export function ComboSelectorModal({ visible, product, presentation, onAdd, onClose }: Props) {
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebounce(search, 200);
  const [selectedCounts, setSelectedCounts] = useState<Record<string, number>>({});
  const [comboQty, setComboQty] = useState(1);

  if (!product || !presentation || !product.combo_definition) return null;

  const comboDef = product.combo_definition;
  const options = comboDef.options || [];

  const totalSelectedUnits = Object.values(selectedCounts).reduce((a, b) => a + b, 0);
  const minRequired = comboDef.selection_min;
  const maxAllowed = comboDef.selection_max;

  const isExact = minRequired === maxAllowed;
  const isValid = totalSelectedUnits >= minRequired && totalSelectedUnits <= maxAllowed;

  function handleIncrement(option: ComboOption) {
    const current = selectedCounts[option.presentation_id] || 0;
    if (totalSelectedUnits >= maxAllowed) {
      Alert.alert("Límite alcanzado", `El combo permite un máximo de ${maxAllowed} unidades.`);
      return;
    }
    if (option.max_quantity !== null && option.max_quantity !== undefined && current >= option.max_quantity) {
      Alert.alert("Límite de opción", `Esta opción permite un máximo de ${option.max_quantity} unidades.`);
      return;
    }
    setSelectedCounts((prev) => ({
      ...prev,
      [option.presentation_id]: current + 1,
    }));
  }

  function handleDecrement(option: ComboOption) {
    const current = selectedCounts[option.presentation_id] || 0;
    if (current <= 0) return;
    setSelectedCounts((prev) => {
      const next = { ...prev };
      if (current - 1 <= 0) {
        delete next[option.presentation_id];
      } else {
        next[option.presentation_id] = current - 1;
      }
      return next;
    });
  }

  function handleAddCombo() {
    if (!product || !presentation) return;
    if (!isValid) {
      if (totalSelectedUnits < minRequired) {
        Alert.alert("Selección incompleta", `Debes elegir al menos ${minRequired} unidades (llevas ${totalSelectedUnits}).`);
      } else {
        Alert.alert("Exceso de unidades", `El máximo permitido es de ${maxAllowed} unidades (llevas ${totalSelectedUnits}).`);
      }
      return;
    }

    const selections: CartLineSelection[] = [];
    let sortOrder = 0;
    for (const opt of options) {
      const qty = selectedCounts[opt.presentation_id] || 0;
      if (qty > 0) {
        selections.push({
          selectedProductId: opt.product_id || opt.id,
          selectedPresentationId: opt.presentation_id,
          productNameSnapshot: opt.product_name || "Producto",
          presentationNameSnapshot: opt.presentation_name || "Unidad",
          quantity: qty,
          sortOrder: sortOrder++,
        });
      }
    }

    onAdd(product, presentation, comboQty, selections);
    setSelectedCounts({});
    setComboQty(1);
    onClose();
  }

  const filteredOptions = options.filter((o) => {
    const term = debouncedSearch.toLowerCase();
    return (
      (o.product_name || "").toLowerCase().includes(term) ||
      (o.presentation_name || "").toLowerCase().includes(term)
    );
  });

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.container}>
          <View style={styles.header}>
            <View style={{ flex: 1 }}>
              <Text style={styles.title}>{product.name}</Text>
              <Text style={styles.price}>{centsToBs(presentation.price_cents)} · {presentation.name}</Text>
            </View>
            <Pressable onPress={onClose} style={styles.closeBtn}>
              <Text style={styles.closeBtnText}>✕</Text>
            </Pressable>
          </View>

          {/* Banner de regla y contador */}
          <View style={[styles.counterBanner, isValid ? styles.counterBannerValid : styles.counterBannerPending]}>
            <Text style={[styles.counterText, isValid && styles.counterTextValid]}>
              Elegidos: {totalSelectedUnits} de {isExact ? minRequired : `${minRequired}-${maxAllowed}`}
            </Text>
            <Text style={styles.counterHint}>
              {isValid
                ? "✓ Regla cumplida lista para agregar"
                : isExact
                ? `Debes seleccionar exactamente ${minRequired} unidades`
                : `Debes seleccionar entre ${minRequired} y ${maxAllowed} unidades`}
            </Text>
          </View>

          <TextInput
            style={styles.search}
            placeholder="Buscar opción / sabor..."
            placeholderTextColor={colors.textMuted}
            value={search}
            onChangeText={setSearch}
          />

          <FlatList
            data={filteredOptions}
            keyExtractor={(o) => o.id || o.presentation_id}
            style={{ maxHeight: 320 }}
            renderItem={({ item }) => {
              const count = selectedCounts[item.presentation_id] || 0;
              const maxLabel = item.max_quantity ? ` (Máx: ${item.max_quantity})` : "";
              const cannotIncrement = totalSelectedUnits >= maxAllowed || (item.max_quantity != null && count >= item.max_quantity);
              return (
                <View style={styles.optionRow}>
                  <View style={{ flex: 1, marginRight: spacing.sm }}>
                    <Text style={styles.optionName}>{item.product_name || "Producto"}</Text>
                    <Text style={styles.optionSub}>
                      {item.presentation_name || "Unidad"}{maxLabel}
                    </Text>
                  </View>
                  <View style={styles.stepper}>
                    <Pressable
                      style={[styles.stepperBtn, count === 0 && styles.stepperBtnDisabled]}
                      onPress={() => handleDecrement(item)}
                      disabled={count === 0}
                    >
                      <Text style={styles.stepperBtnText}>-</Text>
                    </Pressable>
                    <Text style={styles.stepperValue}>{count}</Text>
                    <Pressable
                      style={[
                        styles.stepperBtn,
                        cannotIncrement && styles.stepperBtnDisabled,
                      ]}
                      onPress={() => handleIncrement(item)}
                      disabled={cannotIncrement}
                    >
                      <Text style={styles.stepperBtnText}>+</Text>
                    </Pressable>
                  </View>
                </View>
              );
            }}
          />

          {/* Cantidad de combos a agregar */}
          <View style={styles.comboQtyRow}>
            <Text style={styles.comboQtyLabel}>Cantidad de combos:</Text>
            <View style={styles.stepper}>
              <Pressable
                style={[styles.stepperBtn, comboQty <= 1 && styles.stepperBtnDisabled]}
                onPress={() => setComboQty((q) => Math.max(1, q - 1))}
              >
                <Text style={styles.stepperBtnText}>-</Text>
              </Pressable>
              <Text style={styles.stepperValue}>{comboQty}</Text>
              <Pressable
                style={styles.stepperBtn}
                onPress={() => setComboQty((q) => q + 1)}
              >
                <Text style={styles.stepperBtnText}>+</Text>
              </Pressable>
            </View>
          </View>

          <Button
            label="Agregar combo"
            onPress={handleAddCombo}
            disabled={!isValid}
            style={{ marginTop: spacing.md }}
          />
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
    maxHeight: "90%",
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    marginBottom: spacing.sm,
  },
  title: { fontSize: 18, fontWeight: "700", color: colors.textPrimary },
  price: { fontSize: 14, fontWeight: "600", color: colors.emeraldDark, marginTop: 2 },
  closeBtn: { padding: spacing.xs },
  closeBtnText: { fontSize: 18, color: colors.textMuted },
  counterBanner: {
    padding: spacing.md,
    borderRadius: radius.md,
    marginBottom: spacing.md,
    alignItems: "center",
  },
  counterBannerPending: {
    backgroundColor: colors.amberBg,
  },
  counterBannerValid: {
    backgroundColor: colors.emeraldTint,
  },
  counterText: {
    fontSize: 16,
    fontWeight: "700",
    color: colors.amberText,
  },
  counterTextValid: {
    color: colors.emeraldDark,
  },
  counterHint: {
    fontSize: 12,
    color: colors.textSecondary,
    marginTop: 2,
  },
  search: {
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
  optionRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: colors.surfaceAlt3,
  },
  optionName: { fontSize: 14, fontWeight: "600", color: colors.textPrimary },
  optionSub: { fontSize: 12, color: colors.textMuted, marginTop: 2 },
  stepper: { flexDirection: "row", alignItems: "center" },
  stepperBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: colors.surfaceAlt,
    alignItems: "center",
    justifyContent: "center",
  },
  stepperBtnDisabled: {
    opacity: 0.4,
  },
  stepperBtnText: {
    fontSize: 18,
    fontWeight: "700",
    color: colors.textPrimary,
  },
  stepperValue: {
    width: 32,
    textAlign: "center",
    fontWeight: "700",
    fontSize: 15,
    color: colors.textPrimary,
  },
  comboQtyRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    borderTopWidth: 1,
    borderTopColor: colors.surfaceAlt3,
    paddingTop: spacing.md,
    marginTop: spacing.sm,
  },
  comboQtyLabel: {
    fontSize: 14,
    fontWeight: "600",
    color: colors.textPrimary,
  },
});
