import React from "react";
import { NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { useAuth } from "../context/AuthContext";
import { LoginScreen } from "../screens/LoginScreen";
import { TabNavigator } from "./TabNavigator";
import { HistoryScreen } from "../screens/HistoryScreen";
import { ClientFormScreen } from "../screens/ClientFormScreen";
import { ProductFormScreen } from "../screens/ProductFormScreen";
import { OrderDetailScreen } from "../screens/OrderDetailScreen";
import { NewSaleScreen } from "../screens/NewSaleScreen";

export type RootStackParamList = {
  Tabs: undefined;
  Historial: undefined;
  NuevoCliente: { clientId?: string; returnToPreventa?: boolean } | undefined;
  NuevoProducto: { productId?: string } | undefined;
  DetallePreventa: { orderId: string };
  EditarPreventa: { orderId: string };
};

const Stack = createNativeStackNavigator<RootStackParamList>();

export function RootNavigator() {
  const { user, loading } = useAuth();

  if (loading) return null; // podría mostrarse un splash aquí

  return (
    <NavigationContainer>
      {!user ? (
        <LoginScreen />
      ) : (
        <Stack.Navigator screenOptions={{ headerShown: false }}>
          <Stack.Screen name="Tabs" component={TabNavigator} />
          <Stack.Screen name="Historial" component={HistoryScreen} options={{ headerShown: true, title: "Registros Históricos" }} />
          <Stack.Screen name="NuevoCliente" component={ClientFormScreen} options={{ headerShown: true, title: "Alta Rápida de Cliente", presentation: "modal" }} />
          <Stack.Screen name="NuevoProducto" component={ProductFormScreen} options={{ headerShown: true, title: "Registrar Producto", presentation: "modal" }} />
          <Stack.Screen name="DetallePreventa" component={OrderDetailScreen} options={{ headerShown: true, title: "Detalle de preventa" }} />
          <Stack.Screen name="EditarPreventa" component={NewSaleScreen} options={{ headerShown: true, title: "Editar preventa" }} />
        </Stack.Navigator>
      )}
    </NavigationContainer>
  );
}
