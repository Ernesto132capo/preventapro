import React, { useEffect, useState } from "react";
import { View, Text, TextInput, StyleSheet, ScrollView } from "react-native";
import { useNavigation, useRoute } from "@react-navigation/native";
import { colors, spacing, radius, touchTarget } from "../theme/tokens";
import { Button } from "../components/Button";
import { useSync } from "../context/SyncContext";
import { createClientLocal, updateClientLocal, getClient } from "../db/repositories/clients";

/** Alta rápida de cliente (Fase 8) — se puede abrir desde Clientes o desde dentro de una preventa.
 *  Si viene `clientId` en los params, funciona como pantalla de edición. */
export function ClientFormScreen() {
  const navigation = useNavigation<any>();
  const route = useRoute<any>();
  const { forceSync } = useSync();
  const returnToPreventa = route.params?.returnToPreventa as boolean | undefined;
  const clientId = route.params?.clientId as string | undefined;
  const isEditing = !!clientId;

  const [businessName, setBusinessName] = useState("");
  const [contactName, setContactName] = useState("");
  const [phone, setPhone] = useState("");
  const [address, setAddress] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(isEditing);

  useEffect(() => {
    navigation.setOptions({ title: isEditing ? "Editar Cliente" : "Alta Rápida de Cliente" });
    if (!clientId) return;
    (async () => {
      const client = await getClient(clientId);
      if (client) {
        setBusinessName(client.business_name);
        setContactName(client.contact_name || "");
        setPhone(client.phone || "");
        setAddress(client.address || "");
      }
      setLoading(false);
    })();
  }, [clientId]);

  async function handleSave() {
    setError(null);
    if (!businessName.trim()) {
      setError("El nombre del negocio es obligatorio.");
      return;
    }
    setSaving(true);
    try {
      const client = isEditing
        ? await updateClientLocal(clientId!, { businessName, contactName, phone, address })
        : await createClientLocal({ businessName, contactName, phone, address });
      await forceSync();
      setSaving(false);
      if (returnToPreventa && !isEditing) {
        navigation.navigate("Tabs", { screen: "Preventa", params: { preselectedClientId: client.id } });
      } else {
        navigation.goBack();
      }
    } catch (err: any) {
      setSaving(false);
      setError(err.message || "No se pudo guardar el cliente.");
    }
  }

  if (loading) return null;

  return (
    <ScrollView style={styles.screen} contentContainerStyle={{ padding: spacing.lg }}>
      <Field label="Nombre del negocio *" value={businessName} onChangeText={setBusinessName} placeholder="Tienda Doña Rosa" />
      <Field label="Nombre del contacto/propietario" value={contactName} onChangeText={setContactName} placeholder="Rosa Mamani" />
      <Field label="Teléfono / WhatsApp" value={phone} onChangeText={setPhone} placeholder="77712345" keyboardType="phone-pad" />
      <Field label="Dirección" value={address} onChangeText={setAddress} placeholder="Av. Principal 123" />

      {error && <Text style={styles.error}>{error}</Text>}

      <Text style={styles.hint}>
        Este cliente se guarda de inmediato en tu dispositivo y se sincronizará automáticamente cuando haya conexión.
      </Text>

      <Button
        label={isEditing ? "Guardar Cambios" : "Guardar Cliente"}
        onPress={handleSave}
        loading={saving}
        style={{ marginTop: spacing.lg }}
      />
    </ScrollView>
  );
}

function Field(props: { label: string; value: string; onChangeText: (t: string) => void; placeholder?: string; keyboardType?: any }) {
  return (
    <View style={{ marginBottom: spacing.md }}>
      <Text style={styles.label}>{props.label}</Text>
      <TextInput
        style={styles.input}
        value={props.value}
        onChangeText={props.onChangeText}
        placeholder={props.placeholder}
        placeholderTextColor={colors.textMuted}
        keyboardType={props.keyboardType}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  label: { fontSize: 12, color: colors.textSecondary, marginBottom: 6 },
  input: {
    minHeight: touchTarget.min,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    backgroundColor: colors.surface,
    fontSize: 15,
    color: colors.textPrimary,
  },
  error: { color: colors.errorText, marginTop: spacing.sm },
  hint: { color: colors.textMuted, fontSize: 12, marginTop: spacing.lg },
});
