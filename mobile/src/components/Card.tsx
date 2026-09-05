import React from "react";
import { View, StyleSheet, ViewStyle } from "react-native";
import { colors, radius, spacing } from "../theme/tokens";

export function Card({ children, style }: { children: React.ReactNode; style?: ViewStyle }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.surfaceAlt3,
  },
});
