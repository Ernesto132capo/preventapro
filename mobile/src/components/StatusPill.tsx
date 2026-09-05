import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { colors, radius } from "../theme/tokens";

type Kind = "synced" | "pending" | "syncing" | "failed" | "offline" | "online" | "visited" | "waiting";

const CONFIG: Record<Kind, { bg: string; text: string; label: string }> = {
  synced: { bg: colors.emeraldTint, text: colors.emeraldDark, label: "Sincronizado" },
  online: { bg: colors.emeraldTint, text: colors.emeraldDark, label: "En línea" },
  pending: { bg: colors.amberBg, text: colors.amberText, label: "Pendiente" },
  syncing: { bg: colors.amberBg, text: colors.amberText, label: "Sincronizando..." },
  offline: { bg: colors.amberBg, text: colors.amberText, label: "Sin conexión" },
  failed: { bg: colors.errorBg, text: colors.errorText, label: "Error de sync" },
  visited: { bg: colors.emeraldTint, text: colors.emeraldDark, label: "Visitado" },
  waiting: { bg: colors.surfaceAlt3, text: colors.textSecondary, label: "Pendiente hoy" },
};

export function StatusPill({ kind, label }: { kind: Kind; label?: string }) {
  const cfg = CONFIG[kind];
  return (
    <View style={[styles.pill, { backgroundColor: cfg.bg }]}>
      <Text style={[styles.text, { color: cfg.text }]}>{label || cfg.label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: radius.pill, alignSelf: "flex-start" },
  text: { fontSize: 11, fontWeight: "600" },
});
