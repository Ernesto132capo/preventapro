import React, { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, FlatList, StyleSheet, Text, View } from "react-native";
import { useFocusEffect, useNavigation, useRoute } from "@react-navigation/native";
import { Button } from "../components/Button";
import { Card } from "../components/Card";
import { CategoryManagerModal } from "../components/CategoryManagerModal";
import { StatusPill } from "../components/StatusPill";
import { useSync } from "../context/SyncContext";
import { listOutboxDetails, OutboxDetail, OutboxSummary } from "../db/outbox";
import { resolveKeepDeleted, prepareConflictRestore, getConflictByOutboxId } from "../db/conflicts";
import { colors, spacing } from "../theme/tokens";
import { syncChangeDate, syncDetailAction, syncDetailStatus } from "../utils/syncDetails";

const PAGE_SIZE = 30;
const EMPTY_SUMMARY: OutboxSummary = { total: 0, pending: 0, syncing: 0, failed: 0, error: 0, conflict: 0 };
const OPERATIONS = { create: "Alta", update: "Actualización", cancel: "Anulación", delete: "Eliminación", restore: "Restauración" };

export function SyncDetailsScreen() {
  const navigation = useNavigation<any>();
  const route = useRoute<any>();
  const { connection, isSyncing, forceSync, refreshPending, syncTick, lastError } = useSync();
  const [errorsOnly, setErrorsOnly] = useState(Boolean(route.params?.errorsOnly));
  const [summary, setSummary] = useState<OutboxSummary>(EMPTY_SUMMARY);
  const [rows, setRows] = useState<OutboxDetail[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [syncBusy, setSyncBusy] = useState(false);
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const rowsRef = useRef<OutboxDetail[]>([]);
  const requestRef = useRef(0);
  const loadingRef = useRef(false);
  const focusedRef = useRef(false);
  const syncBusyRef = useRef(false);
  const lastSyncTickRef = useRef(syncTick);

  const load = useCallback(async (replace = true) => {
    if (!focusedRef.current || (!replace && loadingRef.current)) return;
    const request = ++requestRef.current;
    loadingRef.current = true;
    if (replace) {
      rowsRef.current = [];
      setRows([]);
      setHasMore(false);
      setLoading(true);
      setLoadingMore(false);
    }
    else setLoadingMore(true);
    setLoadError(null);
    try {
      const [nextSummary, page] = await Promise.all([
        refreshPending(),
        listOutboxDetails({ offset: replace ? 0 : rowsRef.current.length, limit: PAGE_SIZE, errorsOnly }),
      ]);
      if (!focusedRef.current || request !== requestRef.current) return;
      const nextRows = replace ? page : Array.from(new Map([...rowsRef.current, ...page].map(row => [row.id, row])).values());
      rowsRef.current = nextRows;
      setRows(nextRows);
      setSummary(nextSummary);
      setHasMore(page.length === PAGE_SIZE);
    } catch (error: any) {
      if (focusedRef.current && request === requestRef.current) {
        setLoadError(error?.message || "No se pudieron cargar los cambios pendientes.");
      }
    } finally {
      if (focusedRef.current && request === requestRef.current) {
        loadingRef.current = false;
        setLoading(false);
        setLoadingMore(false);
      }
    }
  }, [errorsOnly, refreshPending]);

  useEffect(() => { setErrorsOnly(Boolean(route.params?.errorsOnly)); }, [route.params?.errorsOnly]);

  useFocusEffect(useCallback(() => {
    focusedRef.current = true;
    void load();
    return () => { focusedRef.current = false; requestRef.current++; loadingRef.current = false; };
  }, [load]));

  useEffect(() => {
    if (lastSyncTickRef.current !== syncTick) {
      lastSyncTickRef.current = syncTick;
      void load();
    }
  }, [syncTick, load]);

  async function synchronize() {
    if (isSyncing || syncBusyRef.current) return;
    syncBusyRef.current = true;
    setSyncBusy(true);
    setSyncError(null);
    try { await forceSync(); }
    catch (error: any) {
      if (focusedRef.current) setSyncError(error?.message || "No se pudo sincronizar.");
    } finally {
      syncBusyRef.current = false;
      if (focusedRef.current) { setSyncBusy(false); await load(); }
    }
  }

  function closeCategories() {
    setCategoryId(null);
    void load();
  }

  const [resolvingConflict, setResolvingConflict] = useState<string | null>(null);

  async function keepDeleted(item: OutboxDetail) {
    const conflict = await getConflictByOutboxId(item.id);
    if (!conflict) { await load(); return; }
    Alert.alert(
      "Mantener eliminado",
      `Se descartará la edición de "${item.entity_name}" y se reflejará la baja en este teléfono.`,
      [
        { text: "Cancelar", style: "cancel" },
        {
          text: "Mantener eliminado",
          style: "destructive",
          onPress: async () => {
            setResolvingConflict(item.id);
            try { await resolveKeepDeleted(conflict.id); } finally { setResolvingConflict(null); await load(); }
          },
        },
      ]
    );
  }

  async function restoreWithChanges(item: OutboxDetail) {
    const conflict = await getConflictByOutboxId(item.id);
    if (!conflict) { await load(); return; }
    setResolvingConflict(item.id);
    try {
      await prepareConflictRestore(conflict.id);
      await forceSync();
    } catch (error: any) {
      if (focusedRef.current) setSyncError(error?.message || "No se pudo restaurar el registro.");
    } finally {
      setResolvingConflict(null);
      await load();
    }
  }

  const reviewCount = summary.failed + summary.error + summary.conflict;
  const filteredTotal = errorsOnly ? reviewCount : summary.total;

  function renderChange({ item }: { item: OutboxDetail }) {
    const status = syncDetailStatus(item);
    const action = syncDetailAction(item);
    return (
      <Card style={styles.changeCard}>
        <Text style={styles.entityName}>{item.entity_name}</Text>
        {!!item.entity_subtitle && <Text style={styles.caption}>{item.entity_subtitle}</Text>}
        <View style={styles.statusRow}><StatusPill kind={status.kind} label={status.label} /></View>
        <Text style={styles.caption}>{OPERATIONS[item.operation]} · {syncChangeDate(item.created_at)}</Text>
        {!!item.last_error && <Text selectable style={styles.reason}>{item.last_error}</Text>}
        {item.status === "error" && <Text style={styles.help}>Revisa los datos del registro antes de volver a sincronizar.</Text>}
        {!!item.next_retry_at && item.status !== "error" && (
          <Text style={styles.help}>Próximo intento desde {syncChangeDate(item.next_retry_at)}, cuando haya conexión y la app esté activa.</Text>
        )}
        {item.status === "failed" && !item.next_retry_at && <Text style={styles.help}>Se volverá a intentar en la próxima sincronización.</Text>}
        {!item.entity_exists && <Text style={styles.help}>El registro ya no está en este teléfono. Su cambio permanece pendiente de resolver.</Text>}
        {!!item.entity_exists && !action && <Text style={styles.help}>Este registro fue dado de baja. Su cambio permanece pendiente de resolver.</Text>}
        {action && (
          <Button label={action.label} variant="outline" disabled={isSyncing || syncBusy || loading}
            accessibilityLabel={`${action.label}: ${item.entity_name}`}
            style={styles.action}
            onPress={() => {
              if ("categoryId" in action) setCategoryId(action.categoryId);
              else navigation.navigate(action.route, action.params);
            }} />
        )}
        {item.status === "conflict" && (
          <View style={styles.conflictActions}>
            <Button label="Mantener eliminado" variant="danger" disabled={isSyncing || syncBusy || resolvingConflict === item.id}
              onPress={() => { void keepDeleted(item); }} style={styles.action} />
            <Button label="Restaurar con mis cambios" variant="primary" loading={resolvingConflict === item.id}
              disabled={isSyncing || syncBusy || resolvingConflict === item.id || connection === "offline"}
              onPress={() => { void restoreWithChanges(item); }} style={styles.action} />
          </View>
        )}
      </Card>
    );
  }

  return (
    <View style={styles.screen}>
      <FlatList
        data={loading ? [] : rows}
        keyExtractor={item => item.id}
        renderItem={renderChange}
        contentContainerStyle={styles.content}
        refreshing={loading}
        onRefresh={() => { void load(); }}
        ListHeaderComponent={
          <View>
            <Card>
              <Text style={styles.title}>Cambios pendientes</Text>
              <Text style={styles.total}>{summary.total}</Text>
              <Text style={styles.help}>{summary.error} requieren corrección · {summary.conflict} conflictos · {summary.failed} con error temporal</Text>
              <Text style={styles.caption}>Un registro puede tener varios cambios. Se conservan en este teléfono hasta confirmar su envío.</Text>
              <Button label="Sincronizar ahora" onPress={() => { void synchronize(); }}
                disabled={isSyncing || syncBusy || connection === "offline"} loading={isSyncing || syncBusy} style={styles.action} />
              {connection === "offline" && <Text style={styles.help}>Sin conexión. Puedes revisar los datos; se enviarán al recuperar la conexión.</Text>}
              {!!(syncError || lastError) && <Text selectable style={styles.reason}>{syncError || lastError}</Text>}
            </Card>
            <View style={styles.filters}>
              <Button label={`Todos (${summary.total})`} variant={errorsOnly ? "outline" : "secondary"}
                onPress={() => setErrorsOnly(false)} style={styles.filter} />
              <Button label={`Por revisar (${reviewCount})`} variant={errorsOnly ? "secondary" : "outline"}
                onPress={() => setErrorsOnly(true)} style={styles.filter} />
            </View>
            {errorsOnly && <Text style={styles.filterHelp}>Errores de envío y validaciones por corregir. Los reintentos programados aparecen en «Todos».</Text>}
            {!!loadError && (
              <Card style={styles.changeCard}>
                <Text style={styles.reason}>{loadError}</Text>
                <Button label="Volver a cargar" variant="outline" onPress={() => { void load(); }} style={styles.action} />
              </Card>
            )}
          </View>
        }
        ListEmptyComponent={loading ? <ActivityIndicator color={colors.emerald} style={styles.empty} /> : !loadError ? (
          <Card><Text style={styles.help}>{errorsOnly ? "No hay cambios por revisar. Consulta «Todos» para ver los envíos pendientes." : "No hay cambios pendientes de sincronizar."}</Text></Card>
        ) : null}
        ListFooterComponent={!loading && rows.length > 0 ? (
          <View>
            <Text style={styles.filterHelp}>Mostrando {rows.length} de {filteredTotal} cambios.</Text>
            {hasMore && <Button label="Cargar más" variant="outline" loading={loadingMore} disabled={loadingMore}
              onPress={() => { void load(false); }} />}
          </View>
        ) : null}
      />
      <CategoryManagerModal visible={categoryId !== null} selectedCategoryId={categoryId}
        onSelect={() => { void load(); }} onClose={closeCategories} />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.lg, paddingBottom: spacing.xxl },
  title: { fontSize: 18, fontWeight: "700", color: colors.textPrimary },
  total: { fontSize: 32, fontWeight: "700", color: colors.navy, marginTop: spacing.xs },
  caption: { fontSize: 12, color: colors.textSecondary, marginTop: spacing.xs },
  help: { fontSize: 13, color: colors.textSecondary, marginTop: spacing.sm },
  reason: { fontSize: 13, color: colors.errorTextDark, marginTop: spacing.sm },
  entityName: { fontSize: 15, fontWeight: "700", color: colors.textPrimary },
  changeCard: { marginBottom: spacing.md },
  statusRow: { marginVertical: spacing.sm },
  action: { marginTop: spacing.md },
  conflictActions: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm, marginTop: spacing.sm },
  filters: { flexDirection: "row", gap: spacing.sm, marginVertical: spacing.lg },
  filter: { flex: 1, paddingHorizontal: spacing.sm },
  filterHelp: { fontSize: 12, color: colors.textSecondary, marginBottom: spacing.md },
  empty: { padding: spacing.xl },
});
