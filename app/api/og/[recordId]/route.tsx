import admin from 'firebase-admin';
import sharp from 'sharp';
import type { NextRequest } from 'next/server';

// Node.js Runtime指定
export const runtime = 'nodejs';

// Admin SDK初期化（サービスアカウントキーを環境変数から取得）
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

// Next.js API Route
export async function GET(
  _req: NextRequest,
  context: { params: { recordId: string } } | { params: Promise<{ recordId: string }> }
) {
  try {
    // recordId取得
    let recordId: string;
    if ('then' in context.params && typeof context.params.then === 'function') {
      const resolved = await context.params;
      recordId = resolved.recordId;
    } else {
      recordId = (context.params as { recordId: string }).recordId;
    }

    // Firestoreから投稿データ取得
    const snap = await db.collection('posts').doc(recordId).get();
    if (!snap.exists) {
      // 投稿が存在しない場合は404
      return new Response('Not found', { status: 404 });
    }
    const record = snap.data() as { imagePath: string; weeklyThemeId?: string };

    // Storageから画像バッファ取得
    if (!record.imagePath) {
      return new Response('No imagePath', { status: 404 });
    }
    const file = bucket.file(record.imagePath);
    const [imageBuffer] = await file.download();

    // sharpでOGP画像生成
    // 1. 投稿画像を1200x630にリサイズ
    let ogp = sharp(imageBuffer).resize(1200, 630).jpeg();

    // 2. バッジ合成（weeklyThemeIdがある場合のみ）
    if (record.weeklyThemeId) {
      // バッジ画像生成（150x150px, 青背景, 白文字）
      const badgeSvg = `
        <svg width="150" height="150" xmlns="http://www.w3.org/2000/svg">
          <circle cx="75" cy="75" r="70" fill="#3B82F6" stroke="#fff" stroke-width="6"/>
          <text x="50%" y="40%" text-anchor="middle" fill="#fff" font-size="22" font-family="sans-serif" font-weight="bold">WEEKLY</text>
          <text x="50%" y="60%" text-anchor="middle" fill="#fff" font-size="22" font-family="sans-serif" font-weight="bold">THEME</text>
          <text x="50%" y="80%" text-anchor="middle" fill="#fff" font-size="16" font-family="sans-serif">JOINED</text>
        </svg>
      `;
      // SVGはBuffer.from(svg)でバッファ化し、sharpでPNG化
      const badgePng = await sharp(Buffer.from(badgeSvg)).png().toBuffer();
      // バッジを右下に合成
      ogp = ogp.composite([
        {
          input: badgePng,
          top: 630 - 150 - 30, // 30px margin
          left: 1200 - 150 - 30, // 30px margin
        },
      ]);
    }

    // 3. JPEGバッファ取得
    const outputBuffer = await ogp.toBuffer();

    // 4. レスポンス返却（Content-Type: image/jpeg）
    return new Response(new Uint8Array(outputBuffer).buffer, {
      headers: {
        'Content-Type': 'image/jpeg',
        'Cache-Control': 'public, max-age=3600',
      },
    });
  } catch (error) {
    // エラー時は500
    console.error('[OGP_API] Error:', error);
    return new Response('Internal Server Error', { status: 500 });
  }
}