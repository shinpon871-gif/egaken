import { ImageResponse } from 'next/og';

export const runtime = 'edge';

export async function GET(
  request: Request,
  { params }: { params: { recordId: string } }
) {
  return new ImageResponse(
    (
      <div
        style={{
          width: '1200px',
          height: '630px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#ffffff',
          fontSize: '64px',
          fontWeight: 'bold',
          color: '#000',
        }}
      >
        えがけん
      </div>
    ),
    {
      width: 1200,
      height: 630,
    }
  );
}
