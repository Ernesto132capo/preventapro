import React, { useEffect, useState } from "react";
import { View, Text, TextInput, StyleSheet, ScrollView, Pressable, Alert, Modal, FlatList } from "react-native";
import { useNavigation, useRoute } from "@react-navigation/native";
import { colors, spacing, radius, touchTarget } from "../theme/tokens";
import { Button } from "../components/Button";
import { CategoryManagerModal } from "../components/CategoryManagerModal";
import { useSync } from "../context/SyncContext";
import {
  createProductLocal,
  updateProductLocal,
  deleteProductLocal,
  getProduct,
  listProducts,
  EditPresentationInput,
  ComboOptionInput,
  ProductWithPresentations,
} from "../db/repositories/products";
import { getCategory } from "../db/repositories/categories";
import { Category, ProductType } from "../domain/types";
import { centsToBs } from "../domain/pricing";

const DEFAULT_PRESENTATIONS: EditPresentationInput[] = [
  { name: "Unidad", unitEquivalence: 1, priceCents: 0, costCents: 0 },
];

interface FormComboOption {
  presentationId: string;
  productName: string;
  presentationName: string;
  maxQuantity: string; // string for input
  sortOrder: number;
}

export function ProductFormScreen() {
  const navigation = useNavigation<any>();
  const route = useRoute<any>();
  const { pushSync } = useSync();
  const productId = route.params?.productId as string | undefined;
  const isEditing = !!productId;

  const [name, setName] = useState("");
  const [productType, setProductType] = useState<ProductType>("standard");
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [categoryName, setCategoryName] = useState<string | null>(null);
  const [showCategoryModal, setShowCategoryModal] = useState(false);

  // Presentaciones normales / del combo
  const [presentations, setPresentations] = useState<EditPresentationInput[]>(DEFAULT_PRESENTATIONS);

  // Configuración de Combo
  const [selectionMin, setSelectionMin] = useState("4");
  const [selectionMax, setSelectionMax] = useState("4");
  const [comboOptions, setComboOptions] = useState<FormComboOption[]>([]);
  const [showOptionPicker, setShowOptionPicker] = useState(false);
  const [availableProducts, setAvailableProducts] = useState<ProductWithPresentations[]>([]);
  const [optionSearch, setOptionSearch] = useState("");

  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(isEditing);

  useEffect(() => {
    navigation.setOptions({ title: isEditing ? "Editar Producto" : "Registrar Producto" });
    (async () => {
      const allProds = await listProducts();
      setAvailableProducts(allProds.filter((p) => p.id !== productId && p.server_id !== productId && p.product_type !== "combo"));

      if (productId) {
        const product = await getProduct(productId);
        if (product) {
          setName(product.name);
          setProductType(product.product_type || "standard");
          setCategoryId(product.category_id ?? null);
          if (product.category_id) {
            const cat = await getCategory(product.category_id);
            setCategoryName(cat?.name ?? null);
          }
          setPresentations(
            product.presentations.map((p) => ({
              id: p.id,
              name: p.name,
              unitEquivalence: p.unit_equivalence,
              priceCents: p.price_cents,
              costCents: p.cost_cents,
            }))
          );
          if (product.combo_definition) {
            setSelectionMin(String(product.combo_definition.selection_min));
            setSelectionMax(String(product.combo_definition.selection_max));
            const seenPres = new Set<string>();
            const uniqueOpts = (product.combo_definition.options || []).filter((o) => {
              if (seenPres.has(o.presentation_id)) return false;
              seenPres.add(o.presentation_id);
              return true;
            });
            setComboOptions(
              uniqueOpts.map((o) => ({
                presentationId: o.presentation_id,
                productName: o.product_name || "Producto",
                presentationName: o.presentation_name || "Unidad",
                maxQuantity: o.max_quantity ? String(o.max_quantity) : "",
                sortOrder: o.sort_order,
              }))
            );
          }
        }
      }
      setLoading(false);
    })();
  }, [productId]);

  function updatePresentation(idx: number, field: keyof EditPresentationInput, value: string) {
    setPresentations((prev) =>
      prev.map((p, i) => {
        if (i !== idx) return p;
        if (field === "name") return { ...p, name: value };
        const num = Math.round(parseFloat(value || "0") * (field === "priceCents" || field === "costCents" ? 100 : 1));
        return { ...p, [field]: isNaN(num) ? 0 : num };
      })
    );
  }

  function addPresentation() {
    setPresentations((prev) => [...prev, { name: "", unitEquivalence: 1, priceCents: 0, costCents: 0 }]);
  }

  function removePresentation(idx: number) {
    setPresentations((prev) => prev.filter((_, i) => i !== idx));
  }

  function handleSelectCategory(cat: Category | null) {
    setCategoryId(cat ? cat.id : null);
    setCategoryName(cat ? cat.name : null);
  }

  function addComboOption(prod: ProductWithPresentations, pres: any) {
    if (comboOptions.some((o) => o.presentationId === pres.id)) {
      Alert.alert("Opción existente", "Esta presentación ya está agregada al combo.");
      return;
    }
    setComboOptions((prev) => [
      ...prev,
      {
        presentationId: pres.id,
        productName: prod.name,
        presentationName: pres.name,
        maxQuantity: "",
        sortOrder: prev.length,
      },
    ]);
    setShowOptionPicker(false);
  }

  function removeComboOption(idx: number) {
    setComboOptions((prev) => prev.filter((_, i) => i !== idx));
  }

  function updateOptionMaxQuantity(idx: number, val: string) {
    setComboOptions((prev) =>
      prev.map((o, i) => (i === idx ? { ...o, maxQuantity: val } : o))
    );
  }

  async function handleSave() {
    setError(null);
    setSaving(true);
    try {
      const min = parseInt(selectionMin, 10);
      const max = parseInt(selectionMax, 10);

      const comboDefPayload =
        productType === "combo"
          ? {
              selectionMin: isNaN(min) ? 1 : min,
              selectionMax: isNaN(max) ? 1 : max,
              options: comboOptions.map((o, i) => ({
                presentationId: o.presentationId,
                maxQuantity: o.maxQuantity ? parseInt(o.maxQuantity, 10) : null,
                sortOrder: i,
              })),
            }
          : undefined;

      const presToSave =
        productType === "combo"
          ? [
              {
                ...(presentations[0] || { priceCents: 0, costCents: 0 }),
                name: (presentations[0]?.name || "").trim() || "Pack",
                unitEquivalence: presentations[0]?.unitEquivalence || 1,
                priceCents: presentations[0]?.priceCents || 0,
                costCents: presentations[0]?.costCents || 0,
              },
            ]
          : presentations;

      if (isEditing) {
        await updateProductLocal(productId!, {
          name: name.trim(),
          categoryId: categoryId || undefined,
          productType,
          presentations: presToSave,
          comboDefinition: comboDefPayload,
        });
      } else {
        await createProductLocal({
          name: name.trim(),
          categoryId: categoryId || undefined,
          productType,
          presentations: presToSave,
          comboDefinition: comboDefPayload,
        });
      }
      await pushSync();
      setSaving(false);
      navigation.goBack();
    } catch (err: any) {
      setSaving(false);
      setError(err.message || "No se pudo guardar el producto.");
      Alert.alert("Error al guardar", err.message || "No se pudo guardar el producto.");
    }
  }

  function handleDelete() {
    Alert.alert("Eliminar producto", `¿Seguro que quieres eliminar "${name}"? Esta acción no se puede deshacer.`, [
      { text: "Cancelar", style: "cancel" },
      {
        text: "Eliminar",
        style: "destructive",
        onPress: async () => {
          await deleteProductLocal(productId!);
          navigation.goBack();
        },
      },
    ]);
  }

  if (loading) return null;

  return (
    <ScrollView style={styles.screen} contentContainerStyle={{ padding: spacing.lg }}>
      <Field label="Nombre del producto *" value={name} onChangeText={setName} placeholder="ej. Cereal Chocolate o Combo Cereales x4" />

      {/* Selector de Categoría */}
      <View style={{ marginBottom: spacing.md }}>
        <Text style={styles.label}>Categoría</Text>
        <Pressable style={styles.categoryPickerBtn} onPress={() => setShowCategoryModal(true)}>
          <Text style={categoryName ? styles.categoryPickerText : styles.categoryPickerTextPlaceholder}>
            {categoryName ? `📁 ${categoryName}` : "Seleccionar o crear categoría..."}
          </Text>
          <Text style={styles.categoryPickerAction}>Cambiar</Text>
        </Pressable>
      </View>

      {/* Tipo de producto: Normal vs Combo */}
      <View style={{ marginBottom: spacing.lg }}>
        <Text style={styles.label}>Tipo de producto</Text>
        <View style={styles.typeRow}>
          <Pressable
            style={[styles.typeBtn, productType === "standard" && styles.typeBtnActive]}
            onPress={() => setProductType("standard")}
          >
            <Text style={[styles.typeBtnText, productType === "standard" && styles.typeBtnTextActive]}>
              📦 Producto Estándar
            </Text>
          </Pressable>
          <Pressable
            style={[styles.typeBtn, productType === "combo" && styles.typeBtnActive]}
            onPress={() => setProductType("combo")}
          >
            <Text style={[styles.typeBtnText, productType === "combo" && styles.typeBtnTextActive]}>
              🎁 Combo Configurable
            </Text>
          </Pressable>
        </View>
      </View>

      {/* Si es COMBO CONFIGURABLE */}
      {productType === "combo" ? (
        <View style={styles.comboConfigBox}>
          <Text style={styles.sectionTitle}>Reglas del Combo</Text>
          <Text style={styles.hint}>
            Define cuántas unidades totales debe elegir el preventista al agregar este combo.
          </Text>

          <View style={styles.row}>
            <MiniField
              label="Mínimo unidades *"
              value={selectionMin}
              onChangeText={setSelectionMin}
            />
            <MiniField
              label="Máximo unidades *"
              value={selectionMax}
              onChangeText={setSelectionMax}
            />
          </View>

          <Text style={[styles.sectionTitle, { marginTop: spacing.md }]}>Precio del Combo</Text>
          <Text style={styles.hint}>
            El precio del combo es independiente de los componentes que elija el cliente.
          </Text>
          {presentations.slice(0, 1).map((p, idx) => (
            <View key={p.id ?? idx} style={styles.presCard}>
              <View style={styles.presRow}>
                <View style={{ flex: 1, marginRight: spacing.sm }}>
                  <Text style={styles.miniLabel}>Nombre del paquete</Text>
                  <TextInput
                    style={styles.input}
                    value={p.name}
                    onChangeText={(v) => updatePresentation(idx, "name", v)}
                    placeholder="ej. Pack"
                  />
                </View>
                <MiniField
                  label="Precio de venta (Bs.) *"
                  value={p.priceCents ? String(p.priceCents / 100) : ""}
                  onChangeText={(v) => updatePresentation(idx, "priceCents", v)}
                />
              </View>
            </View>
          ))}

          <View style={[styles.rowBetween, { marginTop: spacing.lg, marginBottom: spacing.xs }]}>
            <Text style={styles.sectionTitle}>Opciones del Combo ({comboOptions.length})</Text>
            <Button
              label="+ Agregar opción"
              variant="outline"
              onPress={() => setShowOptionPicker(true)}
              style={{ minHeight: 36, paddingHorizontal: 12 }}
            />
          </View>
          <Text style={styles.hint}>
            Productos / sabores que el preventista puede combinar dentro de este combo.
          </Text>

          {comboOptions.map((opt, idx) => (
            <View key={`${opt.presentationId}-${idx}`} style={styles.optionCard}>
              <View style={styles.rowBetween}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.optionTitle}>{opt.productName}</Text>
                  <Text style={styles.optionSub}>{opt.presentationName}</Text>
                </View>
                <Pressable onPress={() => removeComboOption(idx)} style={styles.removeBtn}>
                  <Text style={{ color: colors.errorText, fontWeight: "700" }}>✕</Text>
                </Pressable>
              </View>
              <View style={{ flexDirection: "row", alignItems: "center", marginTop: spacing.xs }}>
                <Text style={[styles.miniLabel, { marginRight: spacing.sm, marginBottom: 0 }]}>
                  Máx. por combo (opcional):
                </Text>
                <TextInput
                  style={[styles.input, { width: 60, minHeight: 34, paddingVertical: 4, textAlign: "center" }]}
                  value={opt.maxQuantity}
                  onChangeText={(v) => updateOptionMaxQuantity(idx, v)}
                  placeholder="Sin lím."
                  keyboardType="number-pad"
                  placeholderTextColor={colors.textMuted}
                />
              </View>
            </View>
          ))}
        </View>
      ) : (
        /* Si es PRODUCTO NORMAL */
        <View>
          <Text style={styles.sectionTitle}>Presentaciones</Text>
          <Text style={styles.hint}>
            Configura Unidad, Medio Paquete, Paquete, Media Caja, Caja, etc. Indica cuántas unidades contiene cada presentación y su precio de venta.
          </Text>

          {presentations.map((p, idx) => (
            <View key={p.id ?? idx} style={styles.presCard}>
              <View style={styles.presHeader}>
                <TextInput
                  style={[styles.input, { flex: 1 }]}
                  value={p.name}
                  onChangeText={(v) => updatePresentation(idx, "name", v)}
                  placeholder="Nombre (ej. Caja)"
                  placeholderTextColor={colors.textMuted}
                />
                {presentations.length > 1 && (
                  <Pressable onPress={() => removePresentation(idx)} style={styles.removeBtn}>
                    <Text style={{ color: colors.errorText }}>✕</Text>
                  </Pressable>
                )}
              </View>
              <View style={styles.presRow}>
                <MiniField label="Equivalencia (uds.)" value={String(p.unitEquivalence)} onChangeText={(v) => updatePresentation(idx, "unitEquivalence", v)} />
                <MiniField label="Precio de venta (Bs.)" value={p.priceCents ? String(p.priceCents / 100) : ""} onChangeText={(v) => updatePresentation(idx, "priceCents", v)} />
              </View>
            </View>
          ))}

          <Button label="+ Agregar presentación" onPress={addPresentation} variant="outline" style={{ marginTop: spacing.sm }} />
        </View>
      )}

      {error && <Text style={styles.error}>{error}</Text>}

      <Button label={isEditing ? "Guardar Cambios" : "Guardar Producto"} onPress={handleSave} loading={saving} style={{ marginTop: spacing.lg }} />

      {isEditing && (
        <Button label="Eliminar Producto" onPress={handleDelete} variant="danger" style={{ marginTop: spacing.md }} />
      )}

      {/* Modal de categorías */}
      <CategoryManagerModal
        visible={showCategoryModal}
        selectedCategoryId={categoryId}
        onSelect={handleSelectCategory}
        onClose={() => setShowCategoryModal(false)}
      />

      {/* Modal para seleccionar opciones de combo */}
      <Modal visible={showOptionPicker} animationType="slide" transparent onRequestClose={() => setShowOptionPicker(false)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <View style={styles.rowBetween}>
              <Text style={styles.sectionTitle}>Agregar Opciones al Combo</Text>
              <Pressable onPress={() => setShowOptionPicker(false)}>
                <Text style={{ fontSize: 18, color: colors.textMuted }}>✕</Text>
              </Pressable>
            </View>
            <TextInput
              style={[styles.input, { marginVertical: spacing.sm }]}
              placeholder="Buscar sabor o producto..."
              placeholderTextColor={colors.textMuted}
              value={optionSearch}
              onChangeText={setOptionSearch}
            />
            <FlatList
              data={availableProducts.filter((p) =>
                p.name.toLowerCase().includes(optionSearch.toLowerCase())
              )}
              keyExtractor={(p) => p.id}
              style={{ maxHeight: 350 }}
              renderItem={({ item: prod }) => (
                <View style={styles.pickerProdGroup}>
                  <Text style={styles.pickerProdName}>{prod.name}</Text>
                  <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.xs, marginTop: 4 }}>
                    {prod.presentations.map((pres) => (
                      <Pressable
                        key={pres.id}
                        style={styles.pickerPresChip}
                        onPress={() => addComboOption(prod, pres)}
                      >
                        <Text style={styles.pickerPresText}>+ {pres.name}</Text>
                      </Pressable>
                    ))}
                  </View>
                </View>
              )}
            />
            <Button label="Cerrar" variant="outline" onPress={() => setShowOptionPicker(false)} style={{ marginTop: spacing.md }} />
          </View>
        </View>
      </Modal>
    </ScrollView>
  );
}

function Field(props: { label: string; value: string; onChangeText: (t: string) => void; placeholder?: string; keyboardType?: any }) {
  return (
    <View style={{ marginBottom: spacing.md }}>
      <Text style={styles.label}>{props.label}</Text>
      <TextInput style={styles.input} value={props.value} onChangeText={props.onChangeText} placeholder={props.placeholder} placeholderTextColor={colors.textMuted} keyboardType={props.keyboardType} />
    </View>
  );
}

function MiniField(props: { label: string; value: string; onChangeText: (t: string) => void }) {
  return (
    <View style={{ flex: 1, marginRight: spacing.sm }}>
      <Text style={styles.miniLabel}>{props.label}</Text>
      <TextInput style={styles.input} value={props.value} onChangeText={props.onChangeText} keyboardType="decimal-pad" placeholderTextColor={colors.textMuted} />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  label: { fontSize: 12, color: colors.textSecondary, marginBottom: 6 },
  miniLabel: { fontSize: 11, color: colors.textMuted, marginBottom: 4 },
  input: {
    minHeight: touchTarget.min,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    backgroundColor: colors.surface,
    fontSize: 14,
    color: colors.textPrimary,
  },
  categoryPickerBtn: {
    minHeight: touchTarget.min,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    backgroundColor: colors.surface,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  categoryPickerText: { fontSize: 14, fontWeight: "600", color: colors.textPrimary },
  categoryPickerTextPlaceholder: { fontSize: 14, color: colors.textMuted },
  categoryPickerAction: { fontSize: 12, color: colors.emeraldDark, fontWeight: "600" },
  typeRow: { flexDirection: "row", gap: spacing.sm },
  typeBtn: {
    flex: 1,
    minHeight: touchTarget.min,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceAlt,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: spacing.sm,
  },
  typeBtnActive: {
    backgroundColor: colors.emerald,
    borderColor: colors.emerald,
  },
  typeBtnText: { fontSize: 13, fontWeight: "600", color: colors.textPrimary },
  typeBtnTextActive: { color: "#fff" },
  sectionTitle: { fontSize: 15, fontWeight: "700", color: colors.textPrimary, marginTop: spacing.md },
  hint: { fontSize: 12, color: colors.textMuted, marginBottom: spacing.md },
  rowBetween: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  row: { flexDirection: "row", marginBottom: spacing.sm },
  presCard: { backgroundColor: colors.surfaceAlt, borderRadius: radius.md, padding: spacing.md, marginBottom: spacing.sm },
  presHeader: { flexDirection: "row", alignItems: "center", marginBottom: spacing.sm },
  presRow: { flexDirection: "row", marginBottom: spacing.sm },
  removeBtn: { marginLeft: spacing.sm, padding: spacing.sm },
  error: { color: colors.errorText, marginTop: spacing.sm },
  comboConfigBox: {
    backgroundColor: colors.surfaceAlt,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  optionCard: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
  },
  optionTitle: { fontSize: 14, fontWeight: "700", color: colors.textPrimary },
  optionSub: { fontSize: 12, color: colors.textMuted, marginTop: 2 },
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.5)",
    justifyContent: "center",
    padding: spacing.lg,
  },
  modalContent: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: spacing.lg,
    maxHeight: "85%",
  },
  pickerProdGroup: {
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.surfaceAlt3,
  },
  pickerProdName: { fontSize: 14, fontWeight: "600", color: colors.textPrimary },
  pickerPresChip: {
    backgroundColor: colors.surfaceAlt,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  pickerPresText: { fontSize: 12, fontWeight: "600", color: colors.textPrimary },
});

