import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { colors, spacing } from "../theme/tokens";

export function EmptyState({ message }: { message: string }) {
  return (
    <View style={styles.wrap}>
      <Text style={styles.text}>{message}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { padding: spacing.xxl, alignItems: "center" },
  text: { color: colors.textMuted, fontSize: 14, textAlign: "center" },
});
