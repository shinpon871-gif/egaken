import { NextRequest, NextResponse } from 'next/server';
import { isXAppBrowserFromUserAgent } from '@/lib/isInAppBrowser';

interface CreatePostRequest {
  userId: string;
  imageUrl: string;
  minutes: number;
  comment: string;
  characterType: string;
  weeklyThemeId: string | null;
  weeklyThemeTitle: string | null;
  showOgp: boolean;
  ogpCrop: {
    x: number;
    y: number;
    width: number;
    height: number;
  } | null;
}

/**
 * 投稿データの作成APIエンドポイント
 * user-agent から X アプリ内ブラウザを検知し、ブロックする
 */
export async function POST(request: NextRequest) {
  // ---- Xアプリ内ブラウザからのリクエストをブロック（二重防御） ----
  const userAgent = request.headers.get('user-agent') || '';
  if (isXAppBrowserFromUserAgent(userAgent)) {
    return NextResponse.json(
      {
        error: 'X_APP_BROWSER_FORBIDDEN',
        message: 'Xアプリ内ブラウザからの投稿はできません',
        detail: 'SafariやChromeなどの通常のブラウザでお試しください',
      },
      { status: 403 }
    );
  }

  try {
    // リクエストボディをパース
    let body: Partial<CreatePostRequest> = {};
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        { error: 'INVALID_JSON', message: 'リクエストボディが無効です' },
        { status: 400 }
      );
    }

    // 必須フィールドの検証
    const { userId, imageUrl, minutes, comment, characterType, weeklyThemeId, weeklyThemeTitle, showOgp, ogpCrop } = body;

    if (!userId || !imageUrl) {
      return NextResponse.json(
        { error: 'MISSING_REQUIRED_FIELDS', message: '必須フィールドが不足しています' },
        { status: 400 }
      );
    }

    // 投稿データを返す（実装の詳細はクライアント側で管理）
    // このAPIはuser-agentチェックが主な役割
    return NextResponse.json(
      {
        success: true,
        message: '投稿可能です',
        data: {
          userId,
          imageUrl,
          minutes: minutes || 0,
          comment: comment || '',
          characterType: characterType || 'strategist',
          weeklyThemeId: weeklyThemeId || null,
          weeklyThemeTitle: weeklyThemeTitle || null,
          showOgp: showOgp !== false,
          ogpCrop: ogpCrop || null,
        },
      },
      { status: 200 }
    );
  } catch (error) {
    console.error('[create-post API] エラー:', error);
    return NextResponse.json(
      { error: 'INTERNAL_ERROR', message: 'サーバーエラーが発生しました' },
      { status: 500 }
    );
  }
}
