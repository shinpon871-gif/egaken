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
    imageExists = res.ok && res.headers.get('content-type')?.startsWith('image');
  } catch {
    imageExists = false;
  }

  // ロゴSVG
  const logoSvg = `<svg width=\"80\" height=\"80\" viewBox=\"0 0 80 80\" fill=\"none\" xmlns=\"http://www.w3.org/2000/svg\"><rect width=\"80\" height=\"80\" rx=\"16\" fill=\"#222\"/><text x=\"40\" y=\"50\" text-anchor=\"middle\" font-size=\"36\" fill=\"#fff\" font-family=\"sans-serif\">絵</text></svg>`;

  return new ImageResponse(
    (
      <div
        style={{
          width: '1200px',
          height: '630px',
          background: '#fff',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          position: 'relative',
        }}
      >
        <div
          style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: '100%',
            height: '100%',
            minHeight: 0,
            minWidth: 0,
          }}
        >
          {imageExists ? (
            <img
              src={imageUrl}
              width={800}
              height={400}
              style={{
                objectFit: 'contain',
                background: '#f8f8f8',
                borderRadius: '16px',
                maxWidth: '800px',
                maxHeight: '400px',
                boxShadow: '0 2px 16px #0002',
              }}
              alt="記録画像"
            />
          ) : (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                width: 400,
                height: 400,
                background: '#f8f8f8',
                borderRadius: '16px',
              }}
            >
              <div
                style={{ marginBottom: 24 }}
                dangerouslySetInnerHTML={{ __html: logoSvg }}
              />
            </div>
          )}
        </div>
        <div
          style={{
            width: '100%',
            position: 'absolute',
            bottom: 0,
            left: 0,
            padding: '32px 0 24px 0',
            background: 'linear-gradient(0deg, #fff 90%, #fff0 100%)',
            textAlign: 'center',
          }}
        >
          <div
            style={{
              fontSize: 48,
              fontWeight: 700,
              color: '#222',
              letterSpacing: 2,
              fontFamily: 'sans-serif',
              marginBottom: 8,
            }}
          >
            えがけん
          </div>
          <div
            style={{
              fontSize: 32,
              color: '#555',
              fontFamily: 'sans-serif',
            }}
          >
            お絵描き記録
          </div>
        </div>
      </div>
    ),
    {
      width: 1200,
      height: 630,
    }
  );
}
