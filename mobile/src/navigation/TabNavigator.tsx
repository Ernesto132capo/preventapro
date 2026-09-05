import React from "react";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { View, Text, StyleSheet } from "react-native";
import { colors } from "../theme/tokens";
import { DashboardScreen } from "../screens/DashboardScreen";
import { ClientsScreen } from "../screens/ClientsScreen";
import { NewSaleScreen } from "../screens/NewSaleScreen";
import { ProductsScreen } from "../screens/ProductsScreen";
import { DailySalesScreen } from "../screens/DailySalesScreen";

const Tab = createBottomTabNavigator();

function TabIcon({ symbol, focused, emphasized }: { symbol: string; focused: boolean; emphasized?: boolean }) {
  return (
    <View
      style={[
        styles.iconWrap,
        emphasized && styles.iconWrapEmphasized,
        focused && !emphasized && styles.iconWrapFocused,
      ]}
    >
      <Text style={[styles.iconText, emphasized && styles.iconTextEmphasized]}>{symbol}</Text>
    </View>
  );
}

/** Navegación inferior de 5 posiciones, con "Preventa" destacada al centro (Fase 4). */
export function TabNavigator() {
  return (
    <Tab.Navigator
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.emerald,
        tabBarInactiveTintColor: colors.textMuted,
        tabBarStyle: { height: 64, paddingBottom: 8, paddingTop: 6, backgroundColor: colors.surface },
      }}
    >
      <Tab.Screen
        name="Inicio"
        component={DashboardScreen}
        options={{ tabBarIcon: ({ focused }) => <TabIcon symbol="🏠" focused={focused} /> }}
      />
      <Tab.Screen
        name="Clientes"
        component={ClientsScreen}
        options={{ tabBarIcon: ({ focused }) => <TabIcon symbol="👥" focused={focused} /> }}
      />
      <Tab.Screen
        name="Preventa"
        component={NewSaleScreen}
        options={{ tabBarIcon: ({ focused }) => <TabIcon symbol="➕" focused={focused} emphasized /> }}
      />
      <Tab.Screen
        name="Productos"
        component={ProductsScreen}
        options={{ tabBarIcon: ({ focused }) => <TabIcon symbol="📦" focused={focused} /> }}
      />
      <Tab.Screen
        name="Registros"
        component={DailySalesScreen}
        options={{ tabBarIcon: ({ focused }) => <TabIcon symbol="📋" focused={focused} /> }}
      />
    </Tab.Navigator>
  );
}

const styles = StyleSheet.create({
  iconWrap: { width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center" },
  iconWrapFocused: { backgroundColor: colors.surfaceAlt2 },
  iconWrapEmphasized: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: colors.emerald,
    marginTop: -20,
    shadowColor: colors.navy,
    shadowOpacity: 0.25,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 3 },
    elevation: 4,
  },
  iconText: { fontSize: 18 },
  iconTextEmphasized: { fontSize: 22 },
});
