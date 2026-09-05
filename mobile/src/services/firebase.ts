import { initializeApp, getApps, getApp } from "firebase/app";
import { initializeAuth, getAuth, Auth } from "firebase/auth";
import * as firebaseAuthPkg from "firebase/auth";
import AsyncStorage from "@react-native-async-storage/async-storage";

const firebaseConfig = {
  apiKey: "AIzaSyD5k_aeO5ImQyaC4bAq8BF-Z9Ztx90pE3g",
  authDomain: "preventasdavid.firebaseapp.com",
  projectId: "preventasdavid",
  storageBucket: "preventasdavid.firebasestorage.app",
  messagingSenderId: "996779892260",
  appId: "1:996779892260:web:f9afa54008cb53cbf202b1",
};

const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApp();

let authInstance: Auth;
try {
  const getPersistence = (firebaseAuthPkg as any).getReactNativePersistence;
  if (typeof getPersistence === "function") {
    authInstance = initializeAuth(app, {
      persistence: getPersistence(AsyncStorage),
    });
  } else {
    authInstance = getAuth(app);
  }
} catch {
  authInstance = getAuth(app);
}

export const firebaseAuth = authInstance;

