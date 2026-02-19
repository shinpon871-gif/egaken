export const dynamic = 'force-static';

import type { Metadata } from 'next';
import SharePostClient from './SharePostClient';

export async function generateMetadata({ params }: { params: { recordId: string } }): Promise<Metadata> {
  const recordId = params.recordId;
  const pageUrl = `https://egaken.vercel.app/share/${recordId}`;
  const imageUrl = `https://egaken.vercel.app/ogp.png`;
  return {
    title: 'えがけん記録',
    description: '今日のイラスト練習記録',
    openGraph: {
      title: 'えがけん記録',
      description: '今日のイラスト練習記録',
      url: pageUrl,
      siteName: 'えがけん',
      images: [
        {
          url: imageUrl,
          width: 1200,
          height: 630,
        },
      ],
      locale: 'ja_JP',
      type: 'website',
    },
    twitter: {
      card: 'summary_large_image',
      title: 'えがけん記録',
      description: '今日のイラスト練習記録',
      images: [imageUrl],
    },
  };
}

export default function Page({ params }: { params: { recordId: string } }) {
  return <SharePostClient recordId={params.recordId} />;
}
