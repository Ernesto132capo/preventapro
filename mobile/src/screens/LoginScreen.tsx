import React, { useState } from "react";
import { View, Text, TextInput, StyleSheet, KeyboardAvoidingView, Platform, Switch, Image } from "react-native";
import { colors, spacing, radius, touchTarget } from "../theme/tokens";
import { Button } from "../components/Button";
import { useAuth } from "../context/AuthContext";

export function LoginScreen() {
  const { login, error } = useAuth();
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  async function handleSubmit() {
    setLocalError(null);
    if (!identifier.trim() || !password) {
      setLocalError("Ingresa tu código y contraseña.");
      return;
    }
    setSubmitting(true);
    await login(identifier.trim(), password, remember);
    setSubmitting(false);
  }

  return (
    <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <View style={styles.header}>
        <Text style={styles.logo}>PreventaPro</Text>
        <Text style={styles.version}>v1.0</Text>
      </View>

      <View style={styles.form}>
        <Text style={styles.label}>Código de Preventista o correo</Text>
        <TextInput
          style={styles.input}
          value={identifier}
          onChangeText={setIdentifier}
          autoCapitalize="none"
          placeholder="PV001"
          placeholderTextColor={colors.textMuted}
        />

        <Text style={styles.label}>Contraseña</Text>
        <TextInput
          style={styles.input}
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          placeholder="••••••••"
          placeholderTextColor={colors.textMuted}
        />

        <View style={styles.rememberRow}>
          <Switch value={remember} onValueChange={setRemember} trackColor={{ true: colors.emerald }} />
          <Text style={styles.rememberLabel}>Recordar sesión</Text>
        </View>

        {(localError || error) && <Text style={styles.error}>{localError || error}</Text>}

        <Button label="Iniciar Sesión" onPress={handleSubmit} loading={submitting} style={{ marginTop: spacing.lg }} />
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.navy, justifyContent: "center", padding: spacing.xl },
  header: { alignItems: "center", marginBottom: spacing.xxl },
  logo: { color: "#fff", fontSize: 28, fontWeight: "700" },
  version: { color: colors.surfaceAlt3, fontSize: 12, marginTop: 4 },
  form: { backgroundColor: colors.surface, borderRadius: radius.lg, padding: spacing.xl },
  label: { color: colors.textSecondary, fontSize: 12, marginTop: spacing.md, marginBottom: 6 },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    minHeight: touchTarget.min,
    paddingHorizontal: spacing.md,
    fontSize: 15,
    color: colors.textPrimary,
    backgroundColor: colors.bg,
  },
  rememberRow: { flexDirection: "row", alignItems: "center", marginTop: spacing.md },
  rememberLabel: { marginLeft: spacing.sm, color: colors.textSecondary, fontSize: 13 },
  error: { color: colors.errorText, marginTop: spacing.md, fontSize: 13 },
});
