// Tokens extraídos directamente del archivo de Figma "App preventa".
// No reemplazar por Material Design genérico — estos son los valores reales del diseño.

export const colors = {
  // Deep Corporate Navy
  navy: "#001428",
  navyDark: "#0b1c30",
  navySoft: "#0f2942",

  // Emerald Green (acciones transaccionales)
  emerald: "#006c4a",
  emeraldDark: "#005137",
  emeraldSoft: "#00714e",
  emeraldTint: "#82f5c1",
  emeraldTint2: "#85f8c4",

  // Amber (advertencias / sincronización)
  amberBg: "#ffdcc3",
  amberText: "#6e3900",

  // Error
  errorBg: "#ffdad6",
  errorText: "#ba1a1a",
  errorTextDark: "#93000a",

  // Superficies
  bg: "#f8f9ff",
  surface: "#ffffff",
  surfaceAlt: "#eff4ff",
  surfaceAlt2: "#e5eeff",
  surfaceAlt3: "#dce9ff",
  surfaceAlt4: "#d3e4fe",

  // Texto / bordes
  textPrimary: "#001428",
  textSecondary: "#43474d",
  textMuted: "#9ca3af",
  border: "#c3c6ce",
};

export const typography = {
  display: { fontFamily: "PlusJakartaSans_700Bold", fontSize: 22 },
  title: { fontFamily: "PlusJakartaSans_600SemiBold", fontSize: 16 },
  value: { fontFamily: "PlusJakartaSans_700Bold", fontSize: 15 },
  body: { fontFamily: "Inter_400Regular", fontSize: 13 },
  caption: { fontFamily: "Inter_400Regular", fontSize: 11 },
  label: { fontFamily: "Inter_500Medium", fontSize: 12 },
};

export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 };

export const radius = { sm: 8, md: 12, lg: 16, pill: 999 };

// Regla del diseño: botones y touch targets de 48-52px mínimo (Fase 43 — accesibilidad de campo)
export const touchTarget = { min: 48, comfortable: 52 };
