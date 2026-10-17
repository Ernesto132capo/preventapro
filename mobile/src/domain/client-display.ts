export interface ClientNameInfo {
  business_name?: string | null;
  contact_name?: string | null;
  businessName?: string | null;
  contactName?: string | null;
}

export interface FormattedClientName {
  primary: string;
  secondary: string | null;
  fullTitle: string;
}

/**
 * Formatea la identificación de un cliente siguiendo las reglas de negocio de PreventaPro:
 * - Caso A (Tiene Nombre de la Tienda Y Nombre del Propietario):
 *   primary: Nombre de la tienda
 *   secondary: Nombre del propietario
 * - Caso B (Solo tiene Nombre del Propietario y NO tiene tienda):
 *   primary: Nombre del propietario
 *   secondary: null (sin líneas vacías)
 * - Caso C (Solo tiene Nombre de la Tienda y NO tiene propietario):
 *   primary: Nombre de la tienda
 *   secondary: null (sin líneas vacías)
 */
export function formatClientDisplayName(client?: ClientNameInfo | null): FormattedClientName {
  const bName = (client?.business_name || client?.businessName || "").trim();
  const cName = (client?.contact_name || client?.contactName || "").trim();

  if (bName && cName) {
    return {
      primary: bName,
      secondary: cName,
      fullTitle: `${bName}\n${cName}`,
    };
  }

  if (cName) {
    return {
      primary: cName,
      secondary: null,
      fullTitle: cName,
    };
  }

  if (bName) {
    return {
      primary: bName,
      secondary: null,
      fullTitle: bName,
    };
  }

  return {
    primary: "Cliente",
    secondary: null,
    fullTitle: "Cliente",
  };
}
