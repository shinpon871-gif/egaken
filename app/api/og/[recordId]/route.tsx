// /app/api/og/[recordId]/route.tsx
import admin from 'firebase-admin';
import sharp from 'sharp';
import type { NextRequest } from 'next/server';

// Node.js Runtime指定（サーバー専用）
export const runtime = 'nodejs';

// ------------------------------
// Firebase Admin SDK 初期化（安全版）
// ------------------------------
let db: admin.firestore.Firestore;
let bucket: any;

try {
  if (!admin.apps.length) {
    if (!process.env.FIREBASE_SERVICE_ACCOUNT_KEY) {
      throw new Error('FIREBASE_SERVICE_ACCOUNT_KEY が未設定です');
    }
    admin.initializeApp({
      credential: admin.credential.cert(
        JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY)
      ),
      storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
    });
    console.log('[OGP_API] Firebase Admin SDK 初期化完了');
  }
  db = admin.firestore();
  bucket = admin.storage().bucket();
} catch (err) {
  console.error('[OGP_API] Firebase Admin SDK 初期化エラー:', err);
  db = null as any;
  bucket = null as any;
}

// ------------------------------
// GET メソッド処理
// ------------------------------
export async function GET(
  _req: NextRequest,
  context: { params: { recordId: string } } | { params: Promise<{ recordId: string }> }
) {
  try {
    if (!db || !bucket) {
      throw new Error('Firestore/Storage が初期化されていません');
    }

    // 1. recordId取得
    let recordId: string;
    if ('then' in context.params && typeof context.params.then === 'function') {
      const resolved = await context.params;
      recordId = resolved.recordId;
    } else {
      recordId = (context.params as { recordId: string }).recordId;
    }
    console.log('[OGP_API] recordId:', recordId);

    // 2. Firestore から投稿データ取得
    const snap = await db.collection('posts').doc(recordId).get();
    if (!snap.exists) return new Response('Not found', { status: 404 });
    const record = snap.data() as { imagePath: string; weeklyThemeId?: string };

    if (!record.imagePath) return new Response('No imagePath', { status: 404 });

    // 3. Storage から投稿画像バッファ取得
    const file = bucket.file(record.imagePath);
    const [imageBuffer] = await file.download();

    // 4. 投稿画像を 1200x630 にリサイズ
    let ogp = sharp(imageBuffer).resize(1200, 630);

    // 5. weeklyThemeId がある場合のみバッジ合成
    if (record.weeklyThemeId) {
      const badgeSvg = `<svg width="150" height="150" xmlns="http://www.w3.org/2000/svg">
        <circle cx="75" cy="75" r="70" fill="#3B82F6" stroke="#fff" stroke-width="6"/>
        <text x="50%" y="40%" text-anchor="middle" fill="#fff" font-size="22" font-family="Arial, sans-serif" font-weight="bold">WEEKLY</text>
        <text x="50%" y="60%" text-anchor="middle" fill="#fff" font-size="22" font-family="Arial, sans-serif" font-weight="bold">THEME</text>
        <text x="50%" y="80%" text-anchor="middle" fill="#fff" font-size="16" font-family="Arial, sans-serif">JOINED</text>
      </svg>`;

      let badgeBuffer: Buffer;
      try {
        badgeBuffer = await sharp(Buffer.from(badgeSvg), { density: 300 })
          .png()
          .toBuffer();
        console.log('[OGP_API] SVGバッジ PNG化完了');
      } catch (err) {
        console.error('[OGP_API] SVG変換エラー:', err);
        throw err;
      }

      ogp = ogp.composite([
        { input: badgeBuffer, top: 630 - 150 - 30, left: 1200 - 150 - 30 },
      ]);
      console.log('[OGP_API] バッジ合成完了');
    }

    // 6. JPEG バッファ取得
    const outputBuffer = await ogp.jpeg().toBuffer();

    // 7. レスポンス返却
    return new Response(new Uint8Array(outputBuffer), {
      headers: {
        'Content-Type': 'image/jpeg',
        'Cache-Control': 'public, max-age=3600',
      },
    });
  } catch (error) {
    console.error('[OGP_API] Error:', error);
    return new Response('Internal Server Error', { status: 500 });
  }
}