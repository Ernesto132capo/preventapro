import admin from "firebase-admin";
if (!admin.apps.length) {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      projectId: serviceAccount.project_id,
    });
  } else {
    // En Render la credencial se entrega por variable de entorno o identidad
    // administrada. No se leen llaves JSON locales desde el repositorio.
    admin.initializeApp({
      credential: admin.credential.applicationDefault(),
    });
  }
}

export const auth = admin.auth();
export { admin };
