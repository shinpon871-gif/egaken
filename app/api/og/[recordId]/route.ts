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

  // ロゴSVG
  const logoSvg = `<svg width="80" height="80" viewBox="0 0 80 80" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="80" height="80" rx="16" fill="#222"/><text x="40" y="50" text-anchor="middle" font-size="36" fill="#fff" font-family="sans-serif">絵</text></svg>`;

  // HTML文字列でOGP画像を生成
  const html = `
    <div style='width:1200px;height:630px;background:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;position:relative;'>
      <div style='flex:1;display:flex;align-items:center;justify-content:center;width:100%;height:100%;min-height:0;min-width:0;'>
        ${imageExists ? `<img src='${imageUrl}' width='800' height='400' style='object-fit:contain;background:#f8f8f8;border-radius:16px;max-width:800px;max-height:400px;box-shadow:0 2px 16px #0002;' alt='記録画像'/>` : `<div style='display:flex;flex-direction:column;align-items:center;justify-content:center;width:400px;height:400px;background:#f8f8f8;border-radius:16px;'><div style='margin-bottom:24px;'>${logoSvg}</div></div>`}
      </div>
      <div style='width:100%;position:absolute;bottom:0;left:0;padding:32px 0 24px 0;background:linear-gradient(0deg,#fff 90%,#fff0 100%);text-align:center;'>
        <div style='font-size:48px;font-weight:700;color:#222;letter-spacing:2px;font-family:sans-serif;margin-bottom:8px;'>えがけん</div>
        <div style='font-size:32px;color:#555;font-family:sans-serif;'>お絵描き記録</div>
      </div>
    </div>
  `;

  return new ImageResponse(html, {
    width: 1200,
    height: 630,
  });
}
