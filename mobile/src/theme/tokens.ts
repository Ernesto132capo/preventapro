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
  display: { fontSize: 22, fontWeight: "700" as const },
  title: { fontSize: 16, fontWeight: "600" as const },
  value: { fontSize: 15, fontWeight: "700" as const },
  body: { fontSize: 13, fontWeight: "400" as const },
  caption: { fontSize: 11, fontWeight: "400" as const },
  label: { fontSize: 12, fontWeight: "500" as const },
};

export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 };

export const radius = { sm: 8, md: 12, lg: 16, pill: 999 };

// Regla del diseño: botones y touch targets de 48-52px mínimo (Fase 43 — accesibilidad de campo)
export const touchTarget = { min: 48, comfortable: 52 };
