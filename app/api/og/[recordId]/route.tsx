// /app/api/og/[recordId]/route.tsx
import sharp from 'sharp';
import path from 'path';
import fs from 'fs';
import admin from 'firebase-admin';
import type { NextRequest } from 'next/server';

export const runtime = 'nodejs';

let db: admin.firestore.Firestore | null = null;
let storage: admin.storage.Storage | null = null;

try {
  let serviceAccount: Record<string, unknown> | null = null;
  let keyError: Error | null = null;
  try {
    const key = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
    if (!key) {
      if (process.env.NODE_ENV === 'production') {
        console.error('[OGP_API] 本番環境で FIREBASE_SERVICE_ACCOUNT_KEY が未設定です。必ず環境変数を設定してください。');
      }
      throw new Error('FIREBASE_SERVICE_ACCOUNT_KEY が未設定');
    }
    try {
      serviceAccount = JSON.parse(key);
      if (serviceAccount && serviceAccount.private_key) {
        (serviceAccount as Record<string, unknown>).private_key = (serviceAccount.private_key as string)
          .replace(/^["']|["']$/g, '') // 前後の引用符を削除
          .replace(/\\n/g, '\n');      // 改行コードを置換
      }
      console.log('[OGP_API] FIREBASE_SERVICE_ACCOUNT_KEY 読み込み成功');
    } catch (parseErr) {
      if (process.env.NODE_ENV === 'production') {
        console.error('[OGP_API] 本番環境で FIREBASE_SERVICE_ACCOUNT_KEY 読み込み失敗', parseErr);
      }
      throw parseErr;
    }
  } catch (e) {
    keyError = e as Error;
    // ローカルのみ JSON ファイルから読み込む（存在すれば）
    try {
      const jsonPath = '../../../../egaken-b4a7e-firebase-adminsdk-fbsvc-dacdaab784.json';
      const jsonContent = fs.readFileSync(path.resolve(process.cwd(), jsonPath), 'utf-8');
      serviceAccount = JSON.parse(jsonContent);
      console.log('[OGP_API] ローカルJSON読み込み成功');
    } catch (e2) {
      console.error('[OGP_API] FIREBASE_SERVICE_ACCOUNT_KEY 読み込み失敗', keyError);
      console.error('[OGP_API] JSONファイルが見つかりません', e2);
    }
  }

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
      credential: admin.credential.cert({
        projectId: (serviceAccount as Record<string, unknown>).project_id as string,
        clientEmail: (serviceAccount as Record<string, unknown>).client_email as string,
        privateKey: (serviceAccount as Record<string, unknown>).private_key as string,
      }),
      storageBucket,
    });
    console.log('[OGP_API] Firebase Admin SDK 初期化完了');
    console.log('[OGP_API] admin.app().options:', admin.app().options);
    console.log('[OGP_API] process.version:', process.version);
  }
  db = admin.firestore();
  // gRPCエラー回避: REST経由でFirestoreを動かす
  db.settings({ experimentalForceLongPolling: true, useFetchStreams: true });
  storage = admin.storage();
} catch (err) {
  console.error('[OGP_API] Firebase Admin SDK 初期化エラー:', err);
  db = null;
  storage = null;
}

export async function GET(
  _req: NextRequest,
  context: { params: Promise<{ recordId: string }> }
): Promise<Response> {
  try {
    console.log('[OGP_API] function start', new Date().toISOString());
    if (!db) {
      console.log('[OGP_API] Firestore 未初期化');
      return new Response('Firestore not initialized', { status: 500 });
    }
    if (!storage) {
      console.log('[OGP_API] Storage 未初期化');
      return new Response('Storage not initialized', { status: 500 });
    }

    // 1. recordId取得
    const { recordId } = await context.params;
    console.log('[OGP_API] recordId:', recordId);

    // Firestore呼び出し直前ログ
    console.log('[OGP_API] before Firestore fetch', new Date().toISOString());

    // 2. Firestore から投稿データ取得（ドキュメントIDで取得）
    // デバッグ: 本番/ローカルの環境変数主要値を出力
    console.log('[OGP_API] process.env.NODE_ENV:', process.env.NODE_ENV);
    console.log('[OGP_API] process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET:', process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET);
    console.log('[OGP_API] process.env.FIREBASE_SERVICE_ACCOUNT_KEY exists:', !!process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
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
    const record = snap.data() as { 
      imageUrl: string; 
      weeklyThemeId?: string;
      ogpCrop?: {
        x: number;
        y: number;
        width: number;
        height: number;
      };
    };

    console.log('[OGP_API] weeklyThemeId:', record.weeklyThemeId);
    console.log('[OGP_API] record.imageUrl:', record.imageUrl);
    console.log('[OGP_API] record.ogpCrop:', JSON.stringify(record.ogpCrop));

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

    // --- 4. トリミング処理（ogpCrop が存在する場合） ---
    let croppedBuffer = imageBuffer;
    if (record.ogpCrop) {
      try {
        const { x, y, width, height } = record.ogpCrop;
        console.log('[OGP_API] トリミング開始日時:', new Date().toISOString());
        console.log('[OGP_API] トリミング元の座標:', { x, y, width, height });
        
        // 念のため数値を正の整数に正規化
        const cropX = Math.max(0, Math.round(x || 0));
        const cropY = Math.max(0, Math.round(y || 0));
        const cropWidth = Math.max(1, Math.round(width || 100));
        const cropHeight = Math.max(1, Math.round(height || 100));
        
        console.log('[OGP_API] トリミング正規化後:', { cropX, cropY, cropWidth, cropHeight });
        
        const startTime = Date.now();
        croppedBuffer = await sharp(imageBuffer)
          .extract({
            left: cropX,
            top: cropY,
            width: cropWidth,
            height: cropHeight,
          })
          .toBuffer();
        
        const duration = Date.now() - startTime;
        console.log(`[OGP_API] トリミング成功（${duration}ms）`);
      } catch (e) {
        console.error('[OGP_API] トリミング処理エラー:', e);
        console.error('[OGP_API] エラーが発生しましたが、元のバッファをそのまま使用します');
        // エラーの場合は元のバッファをそのまま使用
        croppedBuffer = imageBuffer;
      }
    } else {
      console.log('[OGP_API] ogpCropが未設定のため、トリミング処理をスキップ（全体表示）');
    }

    // --- 5. 土台のリサイズを一度確定させる（サイズエラー回避のため） ---
    const OGP_WIDTH = 1200;
    const OGP_HEIGHT = 630;

      // 一度リサイズを実行し、バッファに書き出してサイズを「1200x630」に完全に固定する
      const resizedBaseBuffer = await sharp(croppedBuffer)
        .resize({
          width: OGP_WIDTH,
          height: OGP_HEIGHT,
          fit: 'cover',
          position: sharp.strategy.attention
        })
        .jpeg() // 一度jpeg等で確定（バッファにするため）
        .toBuffer();

    let ogp = sharp(resizedBaseBuffer); 

    // --- 6. 透過済みのバッジ画像を重ねる ---
    if (record.weeklyThemeId) {
      try {
        const badgePath = path.join(process.cwd(), 'assets/badge_ogp.png');
        // 画像を読み込む
        const badgeRawBuffer = fs.readFileSync(badgePath);

        // バッジ画像も土台と同じ 1200x630 にリサイズ（保険：端数によるサイズエラーを防ぐため）
          const resizedBadgeBuffer = await sharp(badgeRawBuffer)
            .resize(OGP_WIDTH, OGP_HEIGHT) // 1ピクセルの狂いもなく土台に合わせる
            .toBuffer();

        // 単に重ねる（Composite）だけで、右上にきれいなバッジが表示されます。
        ogp = ogp.composite([
          {
            input: resizedBadgeBuffer, // 1200x630 の透過画像をそのまま渡す
            // top, left は指定しない（デフォルトで 0, 0）
            // blend はデフォルト（'over'）なので、透過PNGが正しく重なります
          }
        ]);
        console.log('[OGP_API] バッジ画像（透過PNG）の合成成功');
      } catch (e) {
        console.error('[OGP_API] バッジ画像の処理に失敗しました:', e);
      }
    }

    // 7. JPEG バッファ取得
    const outputBuffer = await ogp.jpeg().toBuffer();

    // 8. レスポンス返却
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