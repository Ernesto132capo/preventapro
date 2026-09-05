import React from "react";
import { Pressable, Text, StyleSheet, ActivityIndicator, ViewStyle } from "react-native";
import { colors, radius, touchTarget } from "../theme/tokens";

interface Props {
  label: string;
  onPress: () => void;
  variant?: "primary" | "secondary" | "outline" | "danger";
  disabled?: boolean;
  loading?: boolean;
  style?: ViewStyle;
}

export function Button({ label, onPress, variant = "primary", disabled, loading, style }: Props) {
  const bg = {
    primary: colors.emerald,
    secondary: colors.navy,
    outline: "transparent",
    danger: colors.errorText,
  }[variant];
  const textColor = variant === "outline" ? colors.navy : "#ffffff";

  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || loading}
      style={({ pressed }) => [
        styles.base,
        { backgroundColor: bg, opacity: disabled ? 0.5 : pressed ? 0.85 : 1 },
        variant === "outline" && { borderWidth: 1.5, borderColor: colors.border },
        style,
      ]}
    >
      {loading ? <ActivityIndicator color={textColor} /> : <Text style={[styles.label, { color: textColor }]}>{label}</Text>}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    minHeight: touchTarget.comfortable,
    borderRadius: radius.md,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 16,
  },
  label: { fontSize: 15, fontWeight: "600" },
});
