import React, { useEffect, useState } from "react";
import { View, Text, TextInput, StyleSheet, ScrollView, Pressable, Alert } from "react-native";
import { useNavigation, useRoute } from "@react-navigation/native";
import { colors, spacing, radius, touchTarget } from "../theme/tokens";
import { Button } from "../components/Button";
import {
  createProductLocal,
  updateProductLocal,
  deleteProductLocal,
  getProduct,
  EditPresentationInput,
} from "../db/repositories/products";

const DEFAULT_PRESENTATIONS: EditPresentationInput[] = [
  { name: "Unidad", unitEquivalence: 1, priceCents: 0, costCents: 0, stock: 0 },
];

/** Registrar/Editar Producto (Fase 9/10) — presentaciones múltiples configurables por producto.
 *  Si viene `productId` en los params, funciona como pantalla de edición. */
export function ProductFormScreen() {
  const navigation = useNavigation<any>();
  const route = useRoute<any>();
  const productId = route.params?.productId as string | undefined;
  const isEditing = !!productId;

  const [name, setName] = useState("");
  const [presentations, setPresentations] = useState<EditPresentationInput[]>(DEFAULT_PRESENTATIONS);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(isEditing);

  useEffect(() => {
    navigation.setOptions({ title: isEditing ? "Editar Producto" : "Registrar Producto" });
    if (!productId) return;
    (async () => {
      const product = await getProduct(productId);
      if (product) {
        setName(product.name);
        setPresentations(
          product.presentations.map((p) => ({
            id: p.id,
            name: p.name,
            unitEquivalence: p.unit_equivalence,
            priceCents: p.price_cents,
            costCents: p.cost_cents,
            stock: p.quantity_available,
          }))
        );
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
    setPresentations((prev) => [...prev, { name: "", unitEquivalence: 1, priceCents: 0, costCents: 0, stock: 0 }]);
  }

  function removePresentation(idx: number) {
    setPresentations((prev) => prev.filter((_, i) => i !== idx));
  }

  async function handleSave() {
    setError(null);
    setSaving(true);
    try {
      if (isEditing) {
        await updateProductLocal(productId!, { name: name.trim(), presentations });
      } else {
        await createProductLocal({ name: name.trim(), presentations });
      }
      setSaving(false);
      navigation.goBack();
    } catch (err: any) {
      setSaving(false);
      setError(err.message || "No se pudo guardar el producto.");
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
      <Field label="Nombre del producto *" value={name} onChangeText={setName} placeholder="Yogurt Natural 200ml" />

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

      {error && <Text style={styles.error}>{error}</Text>}

      <Button label={isEditing ? "Guardar Cambios" : "Guardar Producto"} onPress={handleSave} loading={saving} style={{ marginTop: spacing.lg }} />

      {isEditing && (
        <Button label="Eliminar Producto" onPress={handleDelete} variant="danger" style={{ marginTop: spacing.md }} />
      )}
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
  sectionTitle: { fontSize: 15, fontWeight: "700", color: colors.textPrimary, marginTop: spacing.lg },
  hint: { fontSize: 12, color: colors.textMuted, marginBottom: spacing.md },
  presCard: { backgroundColor: colors.surfaceAlt, borderRadius: radius.md, padding: spacing.md, marginBottom: spacing.sm },
  presHeader: { flexDirection: "row", alignItems: "center", marginBottom: spacing.sm },
  presRow: { flexDirection: "row", marginBottom: spacing.sm },
  removeBtn: { marginLeft: spacing.sm, padding: spacing.sm },
  error: { color: colors.errorText, marginTop: spacing.sm },
});
