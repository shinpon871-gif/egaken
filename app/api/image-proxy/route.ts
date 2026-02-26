import { NextRequest, NextResponse } from 'next/server';
import { storage } from '@/lib/firebase';

/**
 * Firebase Storage の画像をプロキシして返す API
 * CORS エラーを回避するため、サーバーサイドで画像を取得する
 * 
 * Usage: /api/image?url=<BASE64_ENCODED_URL>
 */
export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const encodedUrl = searchParams.get('url');

    if (!encodedUrl) {
      return NextResponse.json(
        { error: 'URL parameter is required' },
        { status: 400 }
      );
    }

    // URL エンコードされたURLをデコード
    let imageUrl: string;
    try {
      imageUrl = decodeURIComponent(encodedUrl);
    } catch (error) {
      return NextResponse.json(
        { error: 'Invalid URL encoding' },
        { status: 400 }
      );
    }

    // 再構築：/o/ 以下のオブジェクト名を確実にエンコードする
    let fetchUrl = imageUrl;
    try {
      const u = new URL(imageUrl);
      const parts = u.pathname.split('/o/');
      if (parts.length === 2) {
        const prefix = parts[0];
        const objectAndMaybe = parts[1];
        // objectAndMaybe にはオブジェクト名（エンコード済み/未エンコード）と追加パスが含まれないはず
        // search をそのまま付与
        const encodedObject = encodeURIComponent(decodeURIComponent(objectAndMaybe));
        fetchUrl = `${u.origin}${prefix}/o/${encodedObject}${u.search}`;
      }
    } catch (e) {
      console.warn('[ImageProxy] URL parse failed, using original:', e);
    }

    console.log('[ImageProxy] Fetching:', fetchUrl);

    // Firebase Storage から画像を取得
    const response = await fetch(fetchUrl, {
      method: 'GET',
      headers: {
        'Accept': 'image/*',
      },
    });

    if (!response.ok) {
      console.error('[ImageProxy] Fetch failed:', response.status, response.statusText);
      return NextResponse.json(
        { error: `Failed to fetch image: ${response.status}` },
        { status: response.status }
      );
    }

    // 画像のコンテンツタイプを取得
    const contentType = response.headers.get('content-type') || 'image/jpeg';
    const contentLength = response.headers.get('content-length');

    // バッファーに変換
    const arrayBuffer = await response.arrayBuffer();
    const uint8 = new Uint8Array(arrayBuffer);

    // デバッグログ（長さと最初の数バイト）
    console.log('[ImageProxy] content-type:', contentType, 'length:', uint8.length, 'firstBytes:', uint8.slice(0, 8));

    // CORSを許可するレスポンスヘッダーを設定して返す
    return new Response(uint8, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=86400', // 24時間キャッシュ
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET',
        ...(contentLength && { 'Content-Length': contentLength }),
      },
    });
  } catch (error) {
    console.error('[ImageProxy] Error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
