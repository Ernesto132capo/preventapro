import admin from "firebase-admin";
import path from "path";
import fs from "fs";

if (!admin.apps.length) {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      projectId: serviceAccount.project_id,
    });
  } else {
    const defaultJsonPath = path.resolve(__dirname, "../../firebase-service-account.json");
    const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS || defaultJsonPath;

    if (fs.existsSync(credPath)) {
      const serviceAccount = JSON.parse(fs.readFileSync(credPath, "utf-8"));
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        projectId: serviceAccount.project_id,
      });
    } else {
      admin.initializeApp({
        credential: admin.credential.applicationDefault(),
      });
    }
  }
}

export const auth = admin.auth();
export const firestore = admin.firestore();
export { admin };
