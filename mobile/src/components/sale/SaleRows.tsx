import React, { useEffect, useMemo, useState } from "react";
import { View, Text, TextInput, StyleSheet, Pressable } from "react-native";
import { colors, spacing, radius, touchTarget } from "../../theme/tokens";
import { Card } from "../Card";
import { Button } from "../Button";
import { CartLine, Client, Presentation, Product } from "../../domain/types";
import { ProductWithPresentations } from "../../db/repositories/products";
import { centsToBs } from "../../domain/pricing";
import { formatClientDisplayName } from "../../domain/client-display";
import { resolveSelectedPresentation } from "../../utils/catalogSelection";

export const ClientPickerItem = React.memo(function ClientPickerItem({
  client,
  onSelect,
}: {
  client: Client;
  onSelect: (client: Client) => void;
}) {
  const display = formatClientDisplayName(client);
  return (
    <Pressable onPress={() => onSelect(client)}>
      <Card style={{ marginBottom: spacing.sm }}>
        <Text style={styles.clientName}>{display.primary}</Text>
        {!!display.secondary && <Text style={styles.clientSub}>{display.secondary}</Text>}
      </Card>
    </Pressable>
  );
});

export const CartLineItemRow = React.memo(function CartLineItemRow({
  line,
  index,
  onChangeQty,
}: {
  line: CartLine;
  index: number;
  onChangeQty: (idx: number, delta: number) => void;
}) {
  return (
    <View style={styles.cartLine}>
      <View style={{ flex: 1, marginRight: spacing.xs }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
          <Text style={styles.cartLineName}>{line.productName}</Text>
          {line.isCombo && (
            <View style={styles.miniComboBadge}>
              <Text style={styles.miniComboText}>🎁 Combo</Text>
            </View>
          )}
        </View>
        <Text style={styles.cartLineSub}>
          {line.presentationName} · Contiene {line.unitEquivalence} unidad{line.unitEquivalence === 1 ? "" : "es"} · {centsToBs(line.unitPriceCents)}
        </Text>
        {line.selections && line.selections.length > 0 && (
          <View style={styles.cartSelectionsWrap}>
            {line.selections.map((sel, sIdx) => (
              <Text key={sIdx} style={styles.cartSelectionItem}>
                • {sel.quantity} × {sel.productNameSnapshot} ({sel.presentationNameSnapshot})
              </Text>
            ))}
          </View>
        )}
      </View>
      <Pressable onPress={() => onChangeQty(index, -1)} style={styles.qtyBtn}><Text>-</Text></Pressable>
      <Text style={styles.qtyText}>{line.quantity}</Text>
      <Pressable onPress={() => onChangeQty(index, 1)} style={styles.qtyBtn}><Text>+</Text></Pressable>
      <Text style={styles.lineSubtotal}>{centsToBs(line.subtotalCents)}</Text>
    </View>
  );
});

export const ProductPickerItem = React.memo(function ProductPickerItem({
  product,
  onAdd,
  onConfigureCombo,
  onToggleFavorite,
}: {
  product: ProductWithPresentations;
  onAdd: (p: Product, pres: Presentation, qty: number) => void;
  onConfigureCombo: (p: ProductWithPresentations, pres: Presentation) => void;
  onToggleFavorite: (id: string) => void;
}) {
  // Guardar solo el ID: el objeto y su precio siempre vienen del catálogo actual.
  const [selectedPresentationId, setSelectedPresentationId] = useState<string | null>(product.presentations[0]?.id ?? null);
  const selectedPres = useMemo(
    () => resolveSelectedPresentation(product.presentations, selectedPresentationId),
    [product.presentations, selectedPresentationId]
  );
  const [qty, setQty] = useState("1");
  const isCombo = product.product_type === "combo";

  useEffect(() => {
    setSelectedPresentationId(product.presentations[0]?.id ?? null);
    setQty("1");
  }, [product.id]);

  if (product.presentations.length === 0) return null;

  return (
    <Card style={{ marginBottom: spacing.sm }}>
      <View style={styles.pickerHeader}>
        <View style={{ flexDirection: "row", alignItems: "center", flex: 1, marginRight: spacing.xs }}>
          <Text style={styles.pickerName}>{product.name}</Text>
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <Pressable onPress={() => onToggleFavorite(product.id)} style={styles.starBtn}>
            <Text style={{ fontSize: 18 }}>{product.is_favorite ? "⭐" : "☆"}</Text>
          </Pressable>
          {isCombo && (
            <View style={styles.miniComboBadge}>
              <Text style={styles.miniComboText}>🎁 Combo</Text>
            </View>
          )}
        </View>
      </View>
      <Text style={styles.pickerSku}>SKU: {product.sku}</Text>
      <View style={styles.presChoices}>
        {product.presentations.map((p) => (
          <Pressable
            key={p.id}
            onPress={() => {
              setSelectedPresentationId(p.id);
              setQty("1");
            }}
            style={[styles.presChoice, selectedPres?.id === p.id && styles.presChoiceActive]}
          >
            <Text style={[styles.presChoiceText, selectedPres?.id === p.id && { color: "#fff" }]}>{p.name}</Text>
            <Text style={[styles.presChoicePrice, selectedPres?.id === p.id && { color: "#fff" }]}>{centsToBs(p.price_cents)}</Text>
            <Text style={[styles.presChoicePrice, selectedPres?.id === p.id && { color: "#fff" }]}>Contiene {p.unit_equivalence} unidad{p.unit_equivalence === 1 ? "" : "es"}</Text>
          </Pressable>
        ))}
      </View>

      {isCombo ? (
        <View style={styles.comboActionRow}>
          <Button
            label="🎁 Configurar opciones del combo"
            onPress={() => {
              if (selectedPres) onConfigureCombo(product, selectedPres);
            }}
            style={{ flex: 1 }}
          />
        </View>
      ) : (
        <View style={styles.addRow}>
          <TextInput
            style={styles.qtyInput}
            value={qty}
            onChangeText={setQty}
            keyboardType="number-pad"
            maxLength={4}
          />
          <Button
            label="Agregar"
            onPress={() => {
              const n = parseInt(qty, 10);
              if (selectedPres && n > 0) {
                onAdd(product, selectedPres, n);
                setQty("1");
              }
            }}
            style={{ flex: 1, marginLeft: spacing.sm }}
          />
        </View>
      )}
    </Card>
  );
});

export function TotalRow({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <View style={styles.totalRow}>
      <Text style={[styles.totalLabel, bold && { fontWeight: "700", color: colors.textPrimary }]}>{label}</Text>
      <Text style={[styles.totalValue, bold && { fontWeight: "700", fontSize: 16 }]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  clientName: { fontSize: 15, fontWeight: "700", color: colors.textPrimary },
  clientSub: { fontSize: 13, color: colors.textSecondary, marginTop: 2 },
  pickerHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  pickerName: { fontSize: 15, fontWeight: "700", color: colors.textPrimary },
  pickerSku: { fontSize: 12, color: colors.textMuted, marginTop: 2, marginBottom: spacing.sm },
  starBtn: { padding: 2 },
  miniComboBadge: {
    backgroundColor: "#ede9fe",
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: radius.pill,
  },
  miniComboText: {
    fontSize: 10,
    fontWeight: "700",
    color: "#6d28d9",
  },
  presChoices: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  presChoice: { borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, paddingHorizontal: 10, paddingVertical: 6, alignItems: "center" },
  presChoiceActive: { backgroundColor: colors.emerald, borderColor: colors.emerald },
  presChoiceText: { fontSize: 12, fontWeight: "600", color: colors.textPrimary },
  presChoicePrice: { fontSize: 11, color: colors.textSecondary },
  addRow: { flexDirection: "row", marginTop: spacing.md, alignItems: "center" },
  comboActionRow: { marginTop: spacing.md },
  qtyInput: { width: 56, minHeight: touchTarget.min, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, textAlign: "center", backgroundColor: colors.surface },
  cartLine: { flexDirection: "row", alignItems: "flex-start", marginBottom: spacing.sm, borderBottomWidth: 1, borderBottomColor: colors.surfaceAlt3, paddingBottom: spacing.xs },
  cartLineName: { fontSize: 13, fontWeight: "600", color: colors.textPrimary },
  cartLineSub: { fontSize: 11, color: colors.textMuted, marginTop: 1 },
  cartSelectionsWrap: {
    backgroundColor: colors.surfaceAlt,
    padding: 6,
    borderRadius: radius.sm,
    marginTop: 4,
  },
  cartSelectionItem: {
    fontSize: 11,
    color: colors.textSecondary,
    lineHeight: 15,
  },
  qtyBtn: { width: 28, height: 28, borderRadius: 14, backgroundColor: colors.surfaceAlt, alignItems: "center", justifyContent: "center", marginTop: 2 },
  qtyText: { width: 24, textAlign: "center", fontWeight: "600", marginTop: 6 },
  lineSubtotal: { width: 70, textAlign: "right", fontWeight: "700", color: colors.emeraldDark, fontSize: 12, marginTop: 6 },
  totalRow: { flexDirection: "row", justifyContent: "space-between", marginBottom: 4 },
  totalLabel: { fontSize: 12, color: colors.textSecondary },
  totalValue: { fontSize: 12, color: colors.textPrimary },
});
