// 短縮URLリダイレクトAPI (メモリ上のMapで管理)
import { NextRequest, NextResponse } from 'next/server';

// グローバルなメモリMap（プロセス生存中のみ有効）
const imageMap: Map<string, string> = globalThis.__imageMap || (globalThis.__imageMap = new Map());

export function setImageHash(hash: string, url: string) {
  imageMap.set(hash, url);
}

export function getImageUrl(hash: string): string | undefined {
  return imageMap.get(hash);
}

export const GET = async (
  req: NextRequest,
  context: { params: { hash: string } }
) => {
  const { hash } = context.params;
  const url = getImageUrl(hash);
  if (url) {
    // 画像URLにリダイレクト
    return NextResponse.redirect(url, 302);
  }
  // 見つからなければフォールバック画像
  return NextResponse.redirect('https://egaken.vercel.app/ogp.png', 302);
};
