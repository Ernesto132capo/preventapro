import React, { useCallback, useEffect, useState } from "react";
import { View, Text, TextInput, FlatList, StyleSheet, Linking, Pressable, Alert } from "react-native";
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import { colors, spacing, radius, touchTarget } from "../theme/tokens";
import { Card } from "../components/Card";
import { StatusPill } from "../components/StatusPill";
import { EmptyState } from "../components/EmptyState";
import { Button } from "../components/Button";
import { listActiveClients, deleteClientLocal } from "../db/repositories/clients";
import { Client } from "../domain/types";
import { useSync } from "../context/SyncContext";
import { useDebounce } from "../utils/useDebounce";

export function ClientsScreen() {
  const navigation = useNavigation<any>();
  const { syncTick } = useSync();
  const [clients, setClients] = useState<Client[]>([]);
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebounce(search, 300);

  const load = useCallback(async () => {
    setClients(await listActiveClients(debouncedSearch));
  }, [debouncedSearch]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  useEffect(() => {
    if (syncTick > 0) load();
  }, [syncTick]);

  const confirmDelete = useCallback((c: Client) => {
    Alert.alert(
      "Eliminar cliente",
      `¿Seguro que quieres eliminar a "${c.business_name}"? Esta acción no se puede deshacer.`,
      [
        { text: "Cancelar", style: "cancel" },
        {
          text: "Eliminar",
          style: "destructive",
          onPress: async () => {
            await deleteClientLocal(c.id);
            load();
          },
        },
      ]
    );
  }, [load]);

  const renderClientItem = useCallback(
    ({ item }: { item: Client }) => (
      <ClientCardItem
        item={item}
        onEdit={() => navigation.navigate("NuevoCliente", { clientId: item.id })}
        onDelete={() => confirmDelete(item)}
        onStartSale={() => navigation.navigate("Preventa", { preselectedClientId: item.id })}
      />
    ),
    [navigation, confirmDelete]
  );

  return (
    <View style={styles.screen}>
      <View style={styles.headerRow}>
        <Text style={styles.title}>Clientes</Text>
        <Button label="+ Nuevo" onPress={() => navigation.navigate("NuevoCliente")} style={styles.newBtn} />
      </View>

      <TextInput
        style={styles.search}
        placeholder="Buscar por nombre, contacto o teléfono..."
        placeholderTextColor={colors.textMuted}
        value={search}
        onChangeText={setSearch}
      />

      <FlatList
        data={clients}
        keyExtractor={(c) => c.id}
        renderItem={renderClientItem}
        contentContainerStyle={{ padding: spacing.lg, paddingTop: 0 }}
        ListEmptyComponent={<EmptyState message="No tienes clientes registrados." />}
        initialNumToRender={10}
        maxToRenderPerBatch={10}
        windowSize={5}
        removeClippedSubviews={true}
      />
    </View>
  );
}

const ClientCardItem = React.memo(function ClientCardItem({
  item,
  onEdit,
  onDelete,
  onStartSale,
}: {
  item: Client;
  onEdit: () => void;
  onDelete: () => void;
  onStartSale: () => void;
}) {
  return (
    <Card style={{ marginBottom: spacing.sm }}>
      <View style={styles.rowBetween}>
        <Text style={styles.businessName}>{item.business_name}</Text>
      </View>
      {!!item.contact_name && <Text style={styles.subtext}>{item.contact_name}</Text>}
      {!!item.address && <Text style={styles.subtext}>{item.address}</Text>}
      {item.sync_status !== "synced" && <StatusPill kind={item.sync_status as any} />}

      <View style={styles.actionsRow}>
        {!!item.phone && (
          <>
            <Pressable style={styles.actionBtn} onPress={() => Linking.openURL(`tel:${item.phone}`)}>
              <Text style={styles.actionText}>📞 Llamar</Text>
            </Pressable>
            <Pressable
              style={styles.actionBtn}
              onPress={() => Linking.openURL(`https://wa.me/${item.phone!.replace(/\D/g, "")}`)}
            >
              <Text style={styles.actionText}>💬 WhatsApp</Text>
            </Pressable>
          </>
        )}
        <Pressable style={styles.actionBtn} onPress={onEdit}>
          <Text style={styles.actionText}>✏️ Editar</Text>
        </Pressable>
        <Pressable style={[styles.actionBtn, styles.actionBtnDanger]} onPress={onDelete}>
          <Text style={[styles.actionText, { color: colors.errorText }]}>🗑️ Eliminar</Text>
        </Pressable>
        <Pressable style={[styles.actionBtn, styles.actionBtnPrimary]} onPress={onStartSale}>
          <Text style={[styles.actionText, { color: "#fff" }]}>Iniciar preventa</Text>
        </Pressable>
      </View>
    </Card>
  );
});

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  headerRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", padding: spacing.lg, paddingBottom: spacing.sm },
  title: { fontSize: 20, fontWeight: "700", color: colors.textPrimary },
  newBtn: { minHeight: 40, paddingHorizontal: 14 },
  search: {
    marginHorizontal: spacing.lg,
    marginBottom: spacing.md,
    minHeight: touchTarget.min,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
    backgroundColor: colors.surface,
  },
  rowBetween: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start" },
  businessName: { fontSize: 15, fontWeight: "700", color: colors.textPrimary, flex: 1, marginRight: spacing.sm },
  subtext: { fontSize: 13, color: colors.textSecondary, marginTop: 2 },
  actionsRow: { flexDirection: "row", flexWrap: "wrap", marginTop: spacing.md, gap: spacing.sm },
  actionBtn: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceAlt,
  },
  actionBtnPrimary: { backgroundColor: colors.emerald },
  actionBtnDanger: { backgroundColor: colors.errorBg },
  actionText: { fontSize: 12, fontWeight: "600", color: colors.textPrimary },
});
