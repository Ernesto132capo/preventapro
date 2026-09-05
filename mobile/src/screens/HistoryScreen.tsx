import React, { useCallback, useState } from "react";
import { View, Text, FlatList, StyleSheet, Linking, Alert } from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import { colors, spacing } from "../theme/tokens";
import { Card } from "../components/Card";
import { StatusPill } from "../components/StatusPill";
import { EmptyState } from "../components/EmptyState";
import { Button } from "../components/Button";
import { useAuth } from "../context/AuthContext";
import { deleteClosedWorkDayLocal, listClosedWorkDays } from "../db/repositories/workdays";
import { centsToBs } from "../domain/pricing";
import { WorkDay } from "../domain/types";
import { API_BASE_URL } from "../services/config";
import { apiFetch, getAccessToken } from "../services/api";

/** Registros Históricos (Fase 29) — jornadas cerradas, de solo lectura, con enlaces a reportes. */
export function HistoryScreen() {
  const { user } = useAuth();
  const [workDays, setWorkDays] = useState<WorkDay[]>([]);

  const load = useCallback(async () => {
    if (!user) return;
    setWorkDays(await listClosedWorkDays(user.id));
  }, [user]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  async function openReport(workDayServerId: string, fileName: string) {
    const token = await getAccessToken();
    if (!token) return;
    // El navegador no comparte los headers de la app: el backend valida este
    // token en la ruta de reportes antes de entregar el archivo.
    Linking.openURL(`${API_BASE_URL}/reports/${workDayServerId}/${fileName}?access_token=${encodeURIComponent(token)}`);
  }

  async function deleteRecord(item: WorkDay) {
    if (!item.server_id) return;
    try {
      await apiFetch(`/workdays/${item.server_id}`, { method: "DELETE" });
      await deleteClosedWorkDayLocal(item.id);
      await load();
    } catch (err: any) {
      Alert.alert("No se pudo eliminar", err.message || "Intenta nuevamente.");
    }
  }

  function creationTime(value: string) {
    const normalized = value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
    return new Intl.DateTimeFormat("es-BO", { timeZone: "America/La_Paz", hour: "2-digit", minute: "2-digit" }).format(new Date(normalized));
  }

  return (
    <View style={styles.screen}>
      <FlatList
        data={workDays}
        keyExtractor={(w) => w.id}
        contentContainerStyle={{ padding: spacing.lg }}
        ListEmptyComponent={<EmptyState message="Aún no tienes jornadas cerradas." />}
        renderItem={({ item }) => (
          <Card style={{ marginBottom: spacing.sm }}>
            <View style={styles.rowBetween}>
              <Text style={styles.date}>{item.work_date}</Text>
              <StatusPill kind="synced" label="Cerrada" />
            </View>
            <Text style={styles.total}>{centsToBs(item.total_cents)}</Text>
            <Text style={styles.sub}>{item.order_count} preventa(s)</Text>
            <Text style={styles.sub}>Creado a las {creationTime(item.created_at)}</Text>
            {item.server_id && (
              <View style={styles.reportsRow}>
                <Button
                  label="lista_de_productos.xlsx"
                  variant="outline"
                  onPress={() => openReport(item.server_id!, "lista_de_productos.xlsx")}
                  style={{ marginRight: spacing.sm, minHeight: 36, paddingHorizontal: 10 }}
                />
                <Button
                  label="resumen_clientes.xlsx"
                  variant="outline"
                  onPress={() => openReport(item.server_id!, "resumen_clientes.xlsx")}
                  style={{ minHeight: 36, paddingHorizontal: 10 }}
                />
                <Button
                  label="Boletas para imprimir (PDF)"
                  variant="outline"
                  onPress={() => openReport(item.server_id!, "boletas_clientes.pdf")}
                  style={{ minHeight: 36, paddingHorizontal: 10 }}
                />
              </View>
            )}
            <Button
              label="Eliminar registro"
              variant="danger"
              onPress={() => Alert.alert("Eliminar registro", "Se eliminarán esta jornada, sus preventas y reportes. Esta acción no se puede deshacer.", [
                { text: "Cancelar", style: "cancel" },
                { text: "Eliminar", style: "destructive", onPress: () => deleteRecord(item) },
              ])}
              style={{ marginTop: spacing.md, minHeight: 36 }}
            />
          </Card>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  rowBetween: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  date: { fontSize: 14, fontWeight: "700", color: colors.textPrimary, textTransform: "capitalize" },
  total: { fontSize: 22, fontWeight: "700", color: colors.textPrimary, marginTop: 4 },
  sub: { fontSize: 12, color: colors.textMuted },
  reportsRow: { flexDirection: "row", marginTop: spacing.md, flexWrap: "wrap", gap: spacing.sm },
});
