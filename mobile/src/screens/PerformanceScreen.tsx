import React, { useCallback, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import { Button } from "../components/Button";
import { Card } from "../components/Card";
import { getPerformanceMetrics, PerformanceMetric, resetPerformanceMetrics } from "../services/performance";
import { colors, spacing } from "../theme/tokens";

const OPERATIONS: Record<string, { title: string; description: string }> = {
  "sale.catalog_validation": { title: "Comprobar catálogo", description: "Tiempo para revisar los datos de una preventa antes de guardarla." },
  "sale.local_save": { title: "Guardar preventa", description: "Tiempo para guardar la preventa en este teléfono." },
  "db.open": { title: "Preparar almacenamiento", description: "Tiempo para abrir y preparar los datos locales." },
  "db.transaction_wait": { title: "Esperar para guardar", description: "Espera a que terminen otras escrituras locales." },
  "db.transaction": { title: "Escribir datos locales", description: "Tiempo de las escrituras en este teléfono." },
  "sync.queue_wait": { title: "Esperar para sincronizar", description: "Espera a que termine otra sincronización o mantenimiento." },
  "sync.full": { title: "Sincronización completa", description: "Tiempo para consultar cambios y enviar los pendientes." },
  "sync.push": { title: "Enviar cambios", description: "Tiempo de una sincronización que solo envía cambios pendientes." },
  "sync.pull": { title: "Recibir cambios", description: "Tiempo para consultar e integrar los cambios del servidor." },
  "sync.outbox": { title: "Procesar pendientes", description: "Tiempo para procesar los cambios listos para enviar." },
};

function duration(ms: number): string {
  const value = Number.isFinite(ms) ? Math.max(0, ms) : 0;
  return value >= 1000 ? `${(value / 1000).toFixed(2)} s` : `${Math.round(value)} ms`;
}

function recordedAt(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toLocaleString("es-BO", { timeZone: "America/La_Paz" })
    : "Fecha no disponible";
}

export function PerformanceScreen() {
  const [metrics, setMetrics] = useState<PerformanceMetric[]>([]);
  const refresh = useCallback(() => { setMetrics(getPerformanceMetrics()); }, []);
  useFocusEffect(refresh);

  function reset() {
    resetPerformanceMetrics();
    refresh();
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Card>
        <Text accessibilityRole="header" style={styles.title}>Mediciones locales</Text>
        <Text style={styles.help}>Tiempos de esta sesión en este teléfono. Se reinician al reiniciar la app y no se envían al servidor.</Text>
        <Text style={styles.help}>Repite la misma tarea varias veces para comparar. Los tiempos de sincronización también dependen de la conexión.</Text>
        <Button label="Actualizar mediciones" onPress={refresh} variant="outline" style={styles.action} />
      </Card>

      {metrics.length === 0 ? (
        <Card style={styles.metricCard}>
          <Text style={styles.name}>Todavía no hay mediciones</Text>
          <Text style={styles.help}>Guarda una preventa o sincroniza y vuelve a esta pantalla para consultar los tiempos.</Text>
        </Card>
      ) : metrics.map((metric) => {
        const operation = OPERATIONS[metric.name] || { title: "Otra medición", description: "Tiempo de una operación de la app." };
        const average = metric.count > 0 ? metric.totalMs / metric.count : 0;
        return (
          <Card key={metric.name} style={styles.metricCard}>
            <Text accessibilityRole="header" style={styles.name}>{operation.title}</Text>
            <Text style={styles.help}>{operation.description}</Text>
            <View style={styles.durations}>
              <View style={styles.duration}><Text style={styles.caption}>Última</Text><Text style={styles.value}>{duration(metric.lastMs)}</Text></View>
              <View style={styles.duration}><Text style={styles.caption}>Media</Text><Text style={styles.value}>{duration(average)}</Text></View>
              <View style={styles.duration}><Text style={styles.caption}>Máxima</Text><Text style={styles.value}>{duration(metric.maxMs)}</Text></View>
            </View>
            <Text style={styles.help}>{metric.count} mediciones · {metric.failures} con fallo</Text>
            <Text style={styles.caption}>Última medición: {recordedAt(metric.lastRecordedAt)}</Text>
          </Card>
        );
      })}

      {metrics.length > 0 && (
        <View style={styles.reset}>
          <Button label="Borrar mediciones" onPress={reset} variant="outline" />
          <Text style={styles.caption}>Solo borra estos tiempos. Tus preventas y cambios pendientes se conservan.</Text>
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.lg, paddingBottom: spacing.xxl },
  title: { fontSize: 18, fontWeight: "700", color: colors.textPrimary },
  name: { fontSize: 15, fontWeight: "700", color: colors.textPrimary },
  help: { fontSize: 13, color: colors.textSecondary, marginTop: spacing.sm },
  caption: { fontSize: 12, color: colors.textSecondary, marginTop: spacing.xs },
  action: { marginTop: spacing.md },
  metricCard: { marginTop: spacing.md },
  durations: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm, marginTop: spacing.md },
  duration: { flex: 1, minWidth: 75 },
  value: { fontSize: 18, fontWeight: "700", color: colors.navy, marginTop: spacing.xs },
  reset: { marginTop: spacing.lg },
});
