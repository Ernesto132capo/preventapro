import React from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";
import { colors, spacing, radius } from "../theme/tokens";

/** Banner de error de carga recuperable: conserva los datos visibles y permite reintentar. */
export function LoadErrorBanner({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <View style={styles.banner}>
      <Text style={styles.message}>{message}</Text>
      <Pressable onPress={onRetry} style={styles.retryBtn} accessibilityRole="button">
        <Text style={styles.retryText}>Reintentar</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: colors.errorBg,
    borderColor: colors.errorText,
    borderWidth: 1,
    borderRadius: radius.md,
    marginHorizontal: spacing.lg,
    marginBottom: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  message: { flex: 1, color: colors.errorTextDark, fontSize: 13, marginRight: spacing.sm },
  retryBtn: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: radius.md,
    backgroundColor: colors.navy,
    minHeight: 40,
    justifyContent: "center",
  },
  retryText: { color: "#fff", fontSize: 13, fontWeight: "600" },
});
