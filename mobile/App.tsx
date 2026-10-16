import "react-native-get-random-values";
import React, { useEffect, useState } from "react";
import { ActivityIndicator, Text } from "react-native";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { AuthProvider } from "./src/context/AuthContext";
import { SyncProvider } from "./src/context/SyncContext";
import { RootNavigator } from "./src/navigation/RootNavigator";
import { getDb } from "./src/db/client";
import { colors, spacing } from "./src/theme/tokens";

export default function App() {
  const [dbReady, setDbReady] = useState(false);
  const [dbError, setDbError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    getDb()
      .then(() => {
        if (active) setDbReady(true);
      })
      .catch((err) => {
        console.error("Error al inicializar la base de datos local SQLite:", err);
        if (active) setDbError(err?.message || "No se pudo inicializar la base de datos local.");
      });

    return () => {
      active = false;
    };
  }, []);

  if (dbError) {
    return (
      <SafeAreaProvider>
        <SafeAreaView style={{ flex: 1, backgroundColor: colors.navy, justifyContent: "center", alignItems: "center", padding: spacing.xl }}>
          <Text style={{ color: "#fff", fontSize: 18, fontWeight: "700", marginBottom: spacing.md, textAlign: "center" }}>
            Error de inicialización
          </Text>
          <Text style={{ color: colors.surfaceAlt3, fontSize: 14, textAlign: "center" }}>
            {dbError}
          </Text>
        </SafeAreaView>
      </SafeAreaProvider>
    );
  }

  if (!dbReady) {
    return (
      <SafeAreaProvider>
        <SafeAreaView style={{ flex: 1, backgroundColor: colors.navy, justifyContent: "center", alignItems: "center" }}>
          <ActivityIndicator size="large" color={colors.emerald} />
        </SafeAreaView>
      </SafeAreaProvider>
    );
  }

  return (
    <SafeAreaProvider>
      <AuthProvider>
        <SyncProvider>
          <SafeAreaView style={{ flex: 1 }} edges={["top"]}>
            <StatusBar style="dark" />
            <RootNavigator />
          </SafeAreaView>
        </SyncProvider>
      </AuthProvider>
    </SafeAreaProvider>
  );
}
