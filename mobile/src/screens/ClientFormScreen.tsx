import React, { useEffect, useRef, useState } from "react";
import { View, Text, TextInput, StyleSheet, ScrollView, Alert } from "react-native";
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
  const { forceSync, pushSync } = useSync();
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
  const isSubmittingRef = useRef(false);

  useEffect(() => {
    navigation.setOptions({ title: isEditing ? "Editar Cliente" : "Alta Rápida de Cliente" });
    if (!clientId) return;
    (async () => {
      const client = await getClient(clientId);
      if (client) {
        setBusinessName(client.business_name || client.name || "");
        setContactName(client.contact_name || client.owner_name || "");
        setPhone(client.phone || "");
        setAddress(client.address || "");
      }
      setLoading(false);
    })();
  }, [clientId]);

  async function handleSave() {
    if (isSubmittingRef.current || saving) return;
    setError(null);
    const trimmedBusinessName = businessName.trim();
    const trimmedContactName = contactName.trim();
    if (!trimmedBusinessName && !trimmedContactName) {
      const msg = "Debes ingresar al menos el nombre del negocio o el nombre del propietario";
      setError(msg);
      Alert.alert("Dato requerido", msg);
      return;
    }
    isSubmittingRef.current = true;
    setSaving(true);
    try {
      const client = isEditing
        ? await updateClientLocal(clientId!, {
            businessName: trimmedBusinessName || undefined,
            name: trimmedBusinessName || undefined,
            contactName: trimmedContactName || undefined,
            ownerName: trimmedContactName || undefined,
            phone: phone.trim() || undefined,
            address: address.trim() || undefined,
          })
        : await createClientLocal({
            businessName: trimmedBusinessName || undefined,
            name: trimmedBusinessName || undefined,
            contactName: trimmedContactName || undefined,
            ownerName: trimmedContactName || undefined,
            phone: phone.trim() || undefined,
            address: address.trim() || undefined,
          });
      void pushSync().catch(() => {});
      if (returnToPreventa && !isEditing) {
        navigation.navigate("Tabs", { screen: "Preventa", params: { preselectedClientId: client.id } });
      } else {
        navigation.goBack();
      }
    } catch (err: any) {
      setError(err.message || "No se pudo guardar el cliente.");
    } finally {
      isSubmittingRef.current = false;
      setSaving(false);
    }
  }

  if (loading) return null;

  return (
    <ScrollView style={styles.screen} contentContainerStyle={{ padding: spacing.lg }} keyboardShouldPersistTaps="handled">
      <Field label="Nombre del negocio o tienda" value={businessName} onChangeText={setBusinessName} placeholder="Ej. Tienda Doña Rosa (opcional si hay propietario)" maxLength={120} />
      <Field label="Nombre del propietario o contacto" value={contactName} onChangeText={setContactName} placeholder="Ej. Rosa Mamani (opcional si hay negocio)" maxLength={100} />
      <Text style={{ fontSize: 12, color: colors.emeraldDark, marginTop: -spacing.xs, marginBottom: spacing.md, fontWeight: "500" }}>
        * Al menos uno de los dos nombres anteriores debe estar registrado.
      </Text>
      <Field label="Teléfono / WhatsApp" value={phone} onChangeText={setPhone} placeholder="77712345" keyboardType="phone-pad" maxLength={30} />
      <Field label="Dirección" value={address} onChangeText={setAddress} placeholder="Av. Principal 123" maxLength={200} />

      {error && <Text style={styles.error}>{error}</Text>}

      <Text style={styles.hint}>
        Este cliente se guarda de inmediato en tu dispositivo y se sincronizará automáticamente cuando haya conexión.
      </Text>

      <Button
        label={isEditing ? "Guardar Cambios" : "Guardar Cliente"}
        onPress={handleSave}
        loading={saving}
        disabled={saving}
        style={{ marginTop: spacing.lg }}
      />
    </ScrollView>
  );
}

function Field(props: { label: string; value: string; onChangeText: (t: string) => void; placeholder?: string; keyboardType?: any; maxLength?: number }) {
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
        maxLength={props.maxLength}
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
