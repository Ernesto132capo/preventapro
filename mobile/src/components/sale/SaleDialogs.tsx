import React from "react";
import { View, Text, ScrollView, StyleSheet, Pressable, Modal } from "react-native";
import { colors, spacing, radius } from "../../theme/tokens";
import { Button } from "../Button";
import { EmptyState } from "../EmptyState";
import { CartLineItemRow, TotalRow } from "./SaleRows";
import { CartLine, Client } from "../../domain/types";
import { centsToBs, OrderTotals } from "../../domain/pricing";
import { formatClientDisplayName } from "../../domain/client-display";

export interface PriceDiffItem {
  productId: string;
  presentationId: string;
  productName: string;
  presentationName: string;
  historicalPriceCents: number;
  currentPriceCents: number;
  quantity: number;
}


interface CartReviewProps {
  visible: boolean;
  selectedClient: Client | null;
  offline: boolean;
  cart: CartLine[];
  totals: OrderTotals;
  error: string | null;
  saving: boolean;
  editing: boolean;
  onClose: () => void;
  onChangeQty: (index: number, delta: number) => void;
  onSave: () => void;
}

export function CartReviewModal({ visible: cartModalVisible, selectedClient, offline, cart, totals,
  error, saving, editing, onClose, onChangeQty, onSave }: CartReviewProps) {
  return (<Modal
        visible={cartModalVisible}
        animationType="slide"
        transparent={true}
        onRequestClose={onClose}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <View style={styles.modalHeaderRow}>
              <View style={{ flex: 1, marginRight: spacing.sm }}>
                <Text style={styles.modalTitle}>Resumen del Pedido</Text>
                <Text style={styles.modalClientSub}>Cliente: {formatClientDisplayName(selectedClient).primary}</Text>
                {offline && <Text style={styles.offlineHint}>Sin conexión: comprobación del catálogo pendiente.</Text>}
              </View>
              <Pressable onPress={onClose} style={styles.modalCloseBtn}>
                <Text style={styles.modalCloseBtnText}>✕ Seguir agregando</Text>
              </Pressable>
            </View>

            <ScrollView style={styles.modalScroll} keyboardShouldPersistTaps="handled">
              {cart.length > 0 ? (
                <>
                  <Text style={styles.cartTitle}>Productos añadidos ({totals.itemCount} items)</Text>
                  {cart.map((line, idx) => (
                    <CartLineItemRow
                      key={`${line.presentationId}-${idx}`}
                      line={line}
                      index={idx}
                      onChangeQty={onChangeQty}
                    />
                  ))}

                  <View style={styles.totalsBlock}>
                    <TotalRow label="Subtotal bruto" value={centsToBs(totals.subtotalCents)} />
                    <TotalRow label="Total" value={centsToBs(totals.totalCents)} bold />
                  </View>
                </>
              ) : (
                <EmptyState message="El carrito está vacío. Agrega productos desde el catálogo." />
              )}

              {error && <Text style={styles.error}>{error}</Text>}
            </ScrollView>

            <View style={styles.modalFooter}>
              {saving && <Text accessibilityLiveRegion="polite" style={{ color: colors.textSecondary, marginBottom: spacing.sm }}>
                {offline ? "Guardando en este teléfono…" : "Comprobando el catálogo y guardando la preventa…"}
              </Text>}
              <Button
                label={editing ? "GUARDAR CAMBIOS" : "GUARDAR PREVENTA"}
                onPress={onSave}
                loading={saving}
                disabled={saving || cart.length === 0}
              />
              <Button
                label="Volver al catálogo"
                variant="outline"
                onPress={onClose}
                style={{ marginTop: spacing.sm }}
              />
            </View>
          </View>
        </View>
      </Modal>);
}

interface PriceReviewProps {
  visible: boolean;
  differences: PriceDiffItem[];
  originalTotalCents: number;
  estimatedTotalCents: number;
  onKeepHistorical: () => void;
  onUseCurrent: () => void;
  onCancel: () => void;
}

export function PriceReviewModal({ visible: priceDiffModalVisible, differences: priceDifferences,
  originalTotalCents: originalOrderTotalCents, estimatedTotalCents: estimatedNewTotalCents,
  onKeepHistorical, onUseCurrent, onCancel }: PriceReviewProps) {
  return (<Modal
        visible={priceDiffModalVisible}
        animationType="fade"
        transparent={true}
        onRequestClose={onCancel}
      >
        <View style={styles.modalOverlay}>
          <View style={[styles.modalCard, { maxHeight: "85%" }]}>
            <View style={styles.modalHeaderRow}>
              <View style={{ flex: 1, marginRight: spacing.sm }}>
                <Text style={styles.modalTitle}>Precios Actualizados</Text>
                <Text style={styles.modalClientSub}>
                  Hay diferencias entre los precios guardados y los precios actuales del catálogo.
                </Text>
              </View>
            </View>

            <ScrollView style={styles.modalScroll} keyboardShouldPersistTaps="handled">
              <Text style={[styles.cartTitle, { marginBottom: spacing.xs }]}>Productos con cambio de precio:</Text>
              {priceDifferences.map((diff, idx) => (
                <View key={`${diff.presentationId}-${idx}`} style={styles.priceDiffCard}>
                  <Text style={styles.priceDiffProdName}>
                    {diff.productName} · <Text style={{ fontWeight: "400" }}>{diff.presentationName}</Text>
                  </Text>
                  <Text style={styles.priceDiffQty}>Cantidad en preventa: {diff.quantity}</Text>
                  <View style={styles.priceDiffRow}>
                    <View style={styles.priceDiffCol}>
                      <Text style={styles.priceDiffLabel}>Precio guardado:</Text>
                      <Text style={styles.priceDiffOldVal}>{centsToBs(diff.historicalPriceCents)}</Text>
                    </View>
                    <Text style={styles.priceDiffArrow}>➔</Text>
                    <View style={styles.priceDiffCol}>
                      <Text style={styles.priceDiffLabel}>Precio actual:</Text>
                      <Text style={styles.priceDiffNewVal}>{centsToBs(diff.currentPriceCents)}</Text>
                    </View>
                  </View>
                </View>
              ))}

              <View style={[styles.totalsBlock, { marginTop: spacing.md }]}>
                <TotalRow label="Total original de la preventa" value={centsToBs(originalOrderTotalCents)} bold />
                <TotalRow label="Total estimado si se actualizan precios" value={centsToBs(estimatedNewTotalCents)} bold />
                <TotalRow
                  label="Diferencia estimada"
                  value={
                    estimatedNewTotalCents - originalOrderTotalCents > 0
                      ? `+${centsToBs(estimatedNewTotalCents - originalOrderTotalCents)}`
                      : estimatedNewTotalCents - originalOrderTotalCents < 0
                      ? `-${centsToBs(Math.abs(estimatedNewTotalCents - originalOrderTotalCents))}`
                      : centsToBs(0)
                  }
                />
              </View>
            </ScrollView>

            <View style={[styles.modalFooter, { paddingTop: spacing.md }]}>
              <Button
                label="Mantener precios anteriores"
                variant="outline"
                onPress={onKeepHistorical}
                style={{ marginBottom: spacing.xs }}
              />
              <Button
                label="Usar precios actuales"
                variant="primary"
                onPress={onUseCurrent}
                style={{ marginBottom: spacing.xs }}
              />
              <Button
                label="Cancelar edición"
                variant="danger"
                onPress={onCancel}
              />
            </View>
          </View>
        </View>
      </Modal>);
}

interface FinalPriceConfirmProps {
  visible: boolean;
  originalTotalCents: number;
  totals: OrderTotals;
  saving: boolean;
  onConfirm: () => void;
  onClose: () => void;
}

export function FinalPriceConfirmModal({ visible: finalConfirmModalVisible,
  originalTotalCents: originalOrderTotalCents, totals, saving, onConfirm, onClose }: FinalPriceConfirmProps) {
  return (<Modal
        visible={finalConfirmModalVisible}
        animationType="fade"
        transparent={true}
        onRequestClose={onClose}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <View style={styles.modalHeaderRow}>
              <View style={{ flex: 1, marginRight: spacing.sm }}>
                <Text style={styles.modalTitle}>Confirmar cambio de precios</Text>
                <Text style={styles.modalClientSub}>
                  Esta preventa se guardará aplicando los precios vigentes del catálogo.
                </Text>
              </View>
            </View>

            <View style={{ paddingVertical: spacing.md }}>
              <View style={styles.totalsBlock}>
                <TotalRow label="Total anterior" value={centsToBs(originalOrderTotalCents)} />
                <TotalRow label="Total nuevo" value={centsToBs(totals.totalCents)} bold />
                <TotalRow
                  label="Diferencia"
                  value={
                    totals.totalCents - originalOrderTotalCents > 0
                      ? `+${centsToBs(totals.totalCents - originalOrderTotalCents)}`
                      : totals.totalCents - originalOrderTotalCents < 0
                      ? `-${centsToBs(Math.abs(totals.totalCents - originalOrderTotalCents))}`
                      : centsToBs(0)
                  }
                  bold
                />
              </View>
            </View>

            <View style={styles.modalFooter}>
              <Button
                label="Confirmar cambio"
                onPress={onConfirm}
                loading={saving}
                disabled={saving}
                style={{ marginBottom: spacing.xs }}
              />
              <Button
                label="Volver a editar"
                variant="outline"
                onPress={onClose}
                disabled={saving}
              />
            </View>
          </View>
        </View>
      </Modal>);
}

const styles = StyleSheet.create({
  cartTitle: { fontWeight: "700", color: colors.textPrimary, marginBottom: spacing.sm },
  totalsBlock: { borderTopWidth: 1, borderTopColor: colors.surfaceAlt3, marginTop: spacing.sm, paddingTop: spacing.sm },
  error: { color: colors.errorText, marginTop: spacing.sm },
  offlineHint: { color: colors.amberText, marginTop: spacing.xs, fontSize: 12 },
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.5)",
    justifyContent: "flex-end",
  },
  modalCard: {
    backgroundColor: colors.bg,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    maxHeight: "85%",
    padding: spacing.lg,
  },
  modalHeaderRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    paddingBottom: spacing.sm,
    marginBottom: spacing.md,
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: "700",
    color: colors.textPrimary,
  },
  modalClientSub: {
    fontSize: 13,
    color: colors.emeraldDark,
    fontWeight: "600",
    marginTop: 2,
  },
  modalCloseBtn: {
    paddingVertical: 5,
    paddingHorizontal: 10,
    borderRadius: radius.sm,
    backgroundColor: colors.surfaceAlt,
  },
  modalCloseBtnText: {
    fontSize: 12,
    fontWeight: "600",
    color: colors.textSecondary,
  },
  modalScroll: {
    maxHeight: 380,
  },
  modalFooter: {
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: spacing.md,
    marginTop: spacing.sm,
  },
  priceDiffCard: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  priceDiffProdName: {
    fontSize: 14,
    fontWeight: "700",
    color: colors.textPrimary,
    marginBottom: 2,
  },
  priceDiffQty: {
    fontSize: 12,
    color: colors.textSecondary,
    marginBottom: spacing.xs,
  },
  priceDiffRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: colors.surfaceAlt,
    padding: spacing.sm,
    borderRadius: radius.sm,
  },
  priceDiffCol: {
    flex: 1,
  },
  priceDiffLabel: {
    fontSize: 11,
    color: colors.textSecondary,
    marginBottom: 2,
  },
  priceDiffOldVal: {
    fontSize: 13,
    fontWeight: "600",
    color: colors.textSecondary,
  },
  priceDiffNewVal: {
    fontSize: 14,
    fontWeight: "700",
    color: colors.emerald,
  },
  priceDiffArrow: {
    fontSize: 14,
    color: colors.textSecondary,
    marginHorizontal: spacing.sm,
  },
});
