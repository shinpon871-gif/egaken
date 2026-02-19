import { ImageResponse } from 'next/og';
import type { NextRequest } from 'next/server';

export const runtime = 'edge';

export async function GET(req: NextRequest, { params }: { params: { recordId: string } }) {
  const { recordId } = params;
  const imageUrl = `https://egaken.vercel.app/api/image/${recordId}`;

  // 画像が存在するかHEADリクエストで確認
  let imageExists = false;
  try {
    const res = await fetch(imageUrl, { method: 'HEAD' });
    imageExists = res.ok && !!res.headers.get('content-type')?.startsWith('image');
  } catch {
    imageExists = false;
  }

  // SVG文字列でbodyを返す（JSXを使わない）
  const svg = `
    <svg width="1200" height="630" viewBox="0 0 1200 630" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect width="1200" height="630" fill="#fff"/>
      <text x="600" y="315" text-anchor="middle" dominant-baseline="middle" font-size="80" fill="#222" font-family="sans-serif">えがけん</text>
      <text x="600" y="400" text-anchor="middle" dominant-baseline="middle" font-size="48" fill="#555" font-family="sans-serif">お絵描き記録</text>
    </svg>
  `;

  return new ImageResponse(svg, {
    width: 1200,
    height: 630,
  });
}
