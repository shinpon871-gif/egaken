// lib/firebaseAdmin.ts
import admin from "firebase-admin";
import { Bucket } from "@google-cloud/storage";
import path from "path";
import fs from "fs";

let adminDb: admin.firestore.Firestore | null = null;
let adminStorage: Bucket | null = null;

try {
  let serviceAccount: Record<string, unknown> | null = null;

  try {
    // 環境変数から読み込む場合（本番用）
    const key = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
    if (key) {
      serviceAccount = JSON.parse(key);
      if (serviceAccount && serviceAccount.private_key) {
        (serviceAccount as Record<string, unknown>).private_key = ((serviceAccount as Record<string, unknown>).private_key as string)
          .replace(/^["']|["']$/g, "")
          .replace(/\\n/g, "\n");
      }
      console.log("[firebaseAdmin] 環境変数から読み込み成功");
    } else {
      throw new Error("FIREBASE_SERVICE_ACCOUNT_KEY が未設定");
    }
  } catch (envErr) {
    // ローカル JSON ファイルから読み込む
    try {
      const jsonPath = path.join(process.cwd(), "egaken-b4a7e-firebase-adminsdk-fbsvc-dacdaab784.json");
      const fileContent = fs.readFileSync(jsonPath, "utf8");
      serviceAccount = JSON.parse(fileContent);
      console.log("[firebaseAdmin] ローカル JSON 読み込み成功");
    } catch (jsonErr) {
      console.error("[firebaseAdmin] JSON ファイル読み込み失敗", jsonErr);
      throw envErr;
    }
  }

  // Admin SDK 初期化（初回のみ）
  if (!admin.apps.length && serviceAccount) {
    const storageBucket =
      process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET ||
      `${serviceAccount.project_id}.appspot.com`;

    console.log("[firebaseAdmin] Admin 初期化開始");

    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: (serviceAccount as Record<string, unknown>).project_id as string,
        clientEmail: (serviceAccount as Record<string, unknown>).client_email as string,
        privateKey: (serviceAccount as Record<string, unknown>).private_key as string,
      }),
      storageBucket,
    });

    console.log("[firebaseAdmin] Admin initialized");

    // Firestore インスタンス取得（settingsは使わない）
    adminDb = admin.firestore();
    // Storage Bucket インスタンス取得
    adminStorage = admin.storage().bucket();
    console.log("[firebaseAdmin] Storage bucket:", adminStorage.name);
  } else if (admin.apps.length > 0) {
    // 既に初期化済みの場合
    console.log("[firebaseAdmin] 既存 Admin App を再利用");
    adminDb = admin.firestore();
    adminStorage = admin.storage().bucket();
    console.log("[firebaseAdmin] Storage bucket:", adminStorage.name);
  } else {
    throw new Error("Admin SDK が初期化されていません");
  }
} catch (err) {
  console.error("[firebaseAdmin] Firebase Admin SDK 初期化エラー:", err);
  adminDb = null;
  adminStorage = null;
}

/**
 * 9選画像URL取得
 * Firebase Admin を使用して Storage から画像を取得
 * キャッシュバスター付与
 */
export async function getNineShareImageUrl(shareId: string): Promise<string> {
  const bucket = process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET;

  if (!bucket) {
    console.error("[getNineShareImageUrl] bucket undefined");
    return "https://egaken.vercel.app/ogp.png";
  }

  if (!adminStorage) {
    console.error("[getNineShareImageUrl] adminStorage undefined");
    return "https://egaken.vercel.app/ogp.png";
  }

  try {
    const filePath = `nineShares/${shareId}.jpg`;
    const file = adminStorage.file(filePath);

    const [exists] = await file.exists();

    if (exists) {
      console.log("[getNineShareImageUrl] file exists:", filePath);
      const url =
        `https://firebasestorage.googleapis.com/v0/b/${bucket}/o/` +
        `${encodeURIComponent(filePath)}?alt=media`;
      return url;
    }

    console.warn("[getNineShareImageUrl] file not found:", filePath);
  } catch (err) {
    console.error("[getNineShareImageUrl] Storage error", err);
  }

  // fallback
  const path = `nineShares/${shareId}.jpg`;
  const fallback =
    `https://firebasestorage.googleapis.com/v0/b/${bucket}/o/` +
    `${encodeURIComponent(path)}?alt=media`;

  console.log("[getNineShareImageUrl] fallback:", fallback);

  return fallback;
}

/**
 * キャッシュバスター付与
 * 既存のクエリパラメータを破壊しないようにする
 */
export function addCacheBuster(url: string): string {
  try {
    const urlObj = new URL(url);
    urlObj.searchParams.set("t", Date.now().toString());
    return urlObj.toString();
  } catch {
    // URL パースに失敗したら従来の方法でフォールバック
    const separator = url.includes("?") ? "&" : "?";
    return `${url}${separator}t=${Date.now()}`;
  }
}

export { adminDb, adminStorage, admin };