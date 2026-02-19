import type { Metadata } from 'next';
import SharePostClient from './SharePostClient';

export const dynamic = 'force-dynamic';

export async function generateMetadata({
  params,
}: {
  params: { recordId: string };
}): Promise<Metadata> {
  const url = `https://egaken.vercel.app/share/${params.recordId}`;
  const imageUrl = 'https://egaken.vercel.app/ogp.png';

  return {
    title: 'えがけん記録',
    description: 'イラスト練習の記録',
    openGraph: {
      title: 'えがけん記録',
      description: 'イラスト練習の記録',
      url,
      type: 'website',
      images: [
        {
          url: imageUrl,
          width: 1200,
          height: 630,
        },
      ],
    },
    twitter: {
      card: 'summary_large_image',
      title: 'えがけん記録',
      description: 'イラスト練習の記録',
      images: [imageUrl],
    },
  };
}

export default function Page({
  params,
}: {
  params: { recordId: string };
}) {
  return <SharePostClient recordId={params.recordId} />;
}
