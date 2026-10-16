import React, { useState, useRef } from "react";
import { View, Text, TextInput, StyleSheet, KeyboardAvoidingView, Platform, Switch } from "react-native";
import NetInfo from "@react-native-community/netinfo";
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
  const isSubmittingRef = useRef(false);

  async function handleSubmit() {
    if (isSubmittingRef.current || submitting) return;
    setLocalError(null);

    const cleanId = identifier.trim();
    if (!cleanId || !password) {
      setLocalError("Ingresa tu código y contraseña.");
      return;
    }

    isSubmittingRef.current = true;
    setSubmitting(true);

    try {
      // Verificación de conectividad previa para feedback inmediato y claro
      const netState = await NetInfo.fetch();
      if (netState.isConnected === false || netState.isInternetReachable === false) {
        setLocalError("Sin conexión a internet. Para el primer inicio de sesión se requiere conexión a internet.");
        return;
      }

      await login(cleanId, password, remember);
    } catch (err: any) {
      setLocalError(err?.message || "No se pudo iniciar sesión. Verifica tu conexión.");
    } finally {
      isSubmittingRef.current = false;
      setSubmitting(false);
    }
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
          editable={!submitting}
        />

        <Text style={styles.label}>Contraseña</Text>
        <TextInput
          style={styles.input}
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          placeholder="••••••••"
          placeholderTextColor={colors.textMuted}
          editable={!submitting}
        />

        <View style={styles.rememberRow}>
          <Switch
            value={remember}
            onValueChange={setRemember}
            trackColor={{ true: colors.emerald }}
            disabled={submitting}
          />
          <Text style={styles.rememberLabel}>Recordar sesión</Text>
        </View>

        {(localError || error) && <Text style={styles.error}>{localError || error}</Text>}

        <Button
          label="Iniciar Sesión"
          onPress={handleSubmit}
          loading={submitting}
          disabled={submitting}
          style={{ marginTop: spacing.lg }}
        />
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
