// /app/api/og/[recordId]/route.tsx
import sharp from 'sharp';
import admin from 'firebase-admin';
import type { NextRequest } from 'next/server';

export const runtime = 'nodejs';

let db: admin.firestore.Firestore | null = null;
let storage: admin.storage.Storage | null = null;
try {
  let serviceAccount: any = null;

  if (process.env.FIREBASE_SERVICE_ACCOUNT_KEY) {
    try {
      serviceAccount = JSON.parse(
        process.env.FIREBASE_SERVICE_ACCOUNT_KEY.replace(/\\n/g, '\n')
      );
      console.log('[OGP_API] FIREBASE_SERVICE_ACCOUNT_KEY 読み込み成功');
    } catch (e) {
      console.error('[OGP_API] FIREBASE_SERVICE_ACCOUNT_KEY パースエラー', e);
    }
  }

  // ローカルのみ JSON ファイルから読み込む（存在すれば）
  if (!serviceAccount) {
    try {
      serviceAccount = require('../../../../egaken-b4a7e-firebase-adminsdk-fbsvc-5ca1f7bfac.json');
      console.log('[OGP_API] ローカルJSON読み込み成功');
    } catch (e) {
      console.error('[OGP_API] JSONファイルが見つかりません', e);
    }
  }

  // FIREBASE_SERVICE_ACCOUNT_KEYが存在しない場合はエラー返却
  if (!serviceAccount) {
    console.error('[OGP_API] サービスアカウント情報が取得できません');
    throw new Error('Service account not found');
  }

  // Admin SDK 初期化
  if (!admin.apps.length && serviceAccount) {
    const storageBucket = process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET
      ? process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET
      : `${serviceAccount.project_id}.appspot.com`;

    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      storageBucket,
    });
    console.log('[OGP_API] Firebase Admin SDK 初期化完了');
  }
  db = admin.firestore();
  // gRPCエラー回避: REST経由でFirestoreを動かす
  db.settings({ experimentalForceLongPolling: true });
  storage = admin.storage();
} catch (err) {
  console.error('[OGP_API] Firebase Admin SDK 初期化エラー:', err);
  db = null;
  storage = null;
}

export async function GET(
  _req: NextRequest,
  context: { params: { recordId: string } } | { params: Promise<{ recordId: string }> }
): Promise<Response> {
  try {
    if (!db) {
      console.log('[OGP_API] Firestore 未初期化');
      return new Response('Firestore not initialized', { status: 500 });
    }
    if (!storage) {
      console.log('[OGP_API] Storage 未初期化');
      return new Response('Storage not initialized', { status: 500 });
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

    // 2. Firestore から投稿データ取得（ドキュメントIDで取得）
    let snap: admin.firestore.DocumentSnapshot;
    try {
      snap = await db.collection('posts').doc(recordId).get();
    } catch (e) {
      console.log('[OGP_API] Firestore 取得エラー:', e);
      return new Response('Firestore fetch error', { status: 500 });
    }
    if (!snap.exists) {
      console.log('[OGP_API] Firestore: ドキュメントが存在しません', recordId);
      return new Response('Not found', { status: 404 });
    }
    const record = snap.data() as { imageUrl: string; weeklyThemeId?: string };

    console.log('[OGP_API] weeklyThemeId:', record.weeklyThemeId);
    console.log('[OGP_API] record.imageUrl:', record.imageUrl);

    if (!record.imageUrl) {
      console.log('[OGP_API] imageUrlがありません');
      return new Response('No imageUrl', { status: 404 });
    }

    // 3. Storage から画像バッファ取得（非公開バケット対応）
    let imageBuffer: Buffer;
    try {
      if (record.imageUrl.startsWith('https://')) {
        // 公開URLの場合は fetch で取得
        // @ts-expect-error: node-fetch型定義なし
        const fetch = (await import('node-fetch')).default;
        const imageResp = await fetch(record.imageUrl);
        if (!imageResp.ok) {
          console.log('[OGP_API] fetch失敗', record.imageUrl);
          return new Response('Failed to fetch image', { status: 500 });
        }
        imageBuffer = Buffer.from(await imageResp.arrayBuffer());
      } else {
        // gs:// 形式やパスの場合は Storage から取得
        let bucketName = process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET
          ? process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET
          : (admin.app().options.storageBucket as string);
        let filePath = record.imageUrl;
        if (filePath.startsWith('gs://')) {
          const m = filePath.match(/^gs:\/\/(.+?)\/(.+)$/);
          if (m) {
            bucketName = m[1];
            filePath = m[2];
          }
        }
        const file = storage.bucket(bucketName).file(filePath);
        const [data] = await file.download();
        imageBuffer = data;
      }
    } catch (e) {
      console.log('[OGP_API] 画像取得エラー:', e);
      return new Response('Failed to get image', { status: 500 });
    }

    // 4. 投稿画像を 1200x630 にスマートリサイズ（重要領域優先）
    let ogp = sharp(imageBuffer)
      .resize({
        width: 1200,
        height: 630,
        fit: 'cover',
        position: sharp.strategy.entropy
      });

    // OGPキャンバスサイズ (1200x630)
    const OGP_WIDTH = 1200;
    const OGP_HEIGHT = 630;
    const BADGE_SIZE = 60;
    const PADDING_X = 200;
    const PADDING_Y = 40;

    // 5. weeklyThemeId がある場合のみバッジ合成
    if (record.weeklyThemeId) {
      const badgeSvg = `
<svg width="${BADGE_SIZE}" height="${BADGE_SIZE}" xmlns="http://www.w3.org/2000/svg">
  <circle cx="${BADGE_SIZE / 2}" cy="${BADGE_SIZE / 2}" r="${BADGE_SIZE / 2 - 2}" fill="#3B82F6" stroke="#fff" stroke-width="3"/>
  <text x="50%" y="35%" text-anchor="middle" fill="#fff" font-size="10" font-family="Arial, sans-serif" font-weight="bold">WEEKLY</text>
  <text x="50%" y="55%" text-anchor="middle" fill="#fff" font-size="10" font-family="Arial, sans-serif" font-weight="bold">THEME</text>
  <text x="50%" y="75%" text-anchor="middle" fill="#fff" font-size="8" font-family="Arial, sans-serif" font-weight="bold">JOINED</text>
</svg>`;

      const badgeBuffer = await sharp(Buffer.from(badgeSvg), { density: 300 })
        .png()
        .toBuffer();

      // compositeで右上に配置（topを小さくして上部に寄せる）
      ogp = ogp.composite([
        {
          input: badgeBuffer,
          top: PADDING_Y,
          left: OGP_WIDTH - BADGE_SIZE - PADDING_X,
        }
      ]);
      console.log('[OGP_API] バッジ合成：サイズ縮小・右上配置（Y方向余白調整）完了');
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
    console.log('[OGP_API] 予期せぬエラー:', error);
    return new Response('Internal Server Error', { status: 500 });
  }
}