import admin from 'firebase-admin';
import sharp from 'sharp';
import type { NextRequest } from 'next/server';

// Admin SDK初期化
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(
      JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY || '{}')
    ),
    storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  });
}

// Firestore/Storageインスタンス取得
const db = admin.firestore();
const bucket = admin.storage().bucket();

export async function GET(
  _req: NextRequest,
  context: { params: { recordId: string } } | { params: Promise<{ recordId: string }> }
) {
  try {
    // 1. recordId取得
    let recordId: string;
    if ('then' in context.params && typeof context.params.then === 'function') {
      const resolved = await context.params;
      recordId = resolved.recordId;
    } else {
      recordId = (context.params as { recordId: string }).recordId;
    }

    console.log('[OGP_API] recordId:', recordId);

    // 2. Firestoreから投稿データ取得
    const snap = await db.collection('posts').doc(recordId).get();
    if (!snap.exists) return new Response('Not found', { status: 404 });
    const record = snap.data() as { imagePath: string; weeklyThemeId?: string };

    if (!record.imagePath) return new Response('No imagePath', { status: 404 });

    // 3. Storageから投稿画像バッファ取得
    const file = bucket.file(record.imagePath);
    const [imageBuffer] = await file.download();

    // 4. 投稿画像をリサイズ
    let ogp = sharp(imageBuffer).resize(1200, 630);

    // 5. weeklyThemeIdがある場合のみバッジ合成
    if (record.weeklyThemeId) {
      // SVGを1行化して作成
      const badgeSvg = `<svg width="150" height="150" xmlns="http://www.w3.org/2000/svg"><circle cx="75" cy="75" r="70" fill="#3B82F6" stroke="#fff" stroke-width="6"/><text x="50%" y="40%" text-anchor="middle" fill="#fff" font-size="22" font-family="Arial, sans-serif" font-weight="bold">WEEKLY</text><text x="50%" y="60%" text-anchor="middle" fill="#fff" font-size="22" font-family="Arial, sans-serif" font-weight="bold">THEME</text><text x="50%" y="80%" text-anchor="middle" fill="#fff" font-size="16" font-family="Arial, sans-serif">JOINED</text></svg>`;

      let badgeBuffer: Buffer;
      try {
        // density: 300 で文字をくっきり描画
        badgeBuffer = await sharp(Buffer.from(badgeSvg), { density: 300 })
          .png()
          .toBuffer();
        console.log('[OGP_API] SVGバッジ PNG化完了');
      } catch (err) {
        console.error('[OGP_API] SVG変換エラー:', err);
        throw err;
      }

      // 投稿画像に右下マージン30pxでバッジ合成
      ogp = ogp.composite([
        { input: badgeBuffer, top: 630 - 150 - 30, left: 1200 - 150 - 30 },
      ]);
      console.log('[OGP_API] バッジ合成完了');
    }

    // 6. JPEGバッファ取得
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