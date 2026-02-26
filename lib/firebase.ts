import { initializeApp, getApps, getApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";
import { getStorage } from "firebase/storage";

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};

// サーバー・クライアント両方で安全に初期化
const app = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);

// 各サービスをエクスポート（サーバーサイドでも利用可能）
export const auth = getAuth(app);
console.log('[firebase] auth.app.name:', auth.app.name); // デバッグ用: インスタンス名で単一性を確認（修正理由：多重初期化防止、影響範囲：開発時ログのみ）
export const db = getFirestore(app);
export const storage = getStorage(app);
