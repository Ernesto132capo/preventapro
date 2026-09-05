import "react-native-get-random-values";
import React from "react";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { AuthProvider } from "./src/context/AuthContext";
import { SyncProvider } from "./src/context/SyncContext";
import { RootNavigator } from "./src/navigation/RootNavigator";


export default function App() {
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
