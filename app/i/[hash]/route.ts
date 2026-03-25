// 短縮URLリダイレクトAPI
import { NextRequest, NextResponse } from 'next/server';
import { getImageUrl } from '@/lib/imageHash';

export async function GET(
  _req: NextRequest,
  context: { params: Promise<{ hash: string }> }
): Promise<NextResponse> {
  const { hash } = await context.params;
  const url = getImageUrl(hash);
  if (url) {
    // 画像URLにリダイレクト
    return NextResponse.redirect(url, 302);
  }
  // 見つからなければフォールバック画像
  return NextResponse.redirect('https://egaken.vercel.app/ogp.png', 302);
}
