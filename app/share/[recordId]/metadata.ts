import type { Metadata } from 'next';

type Props = { params: { recordId: string } };

export function generateMetadata({ params }: Props): Metadata {
  const recordId = params.recordId;
  return {
    title: 'えがけん記録',
    description: 'イラスト練習の記録',
    openGraph: {
      title: 'えがけん記録',
      description: 'イラスト練習の記録',
      url: `https://egaken.vercel.app/share/${recordId}`,
      type: 'website',
      images: [
        {
          url: `https://egaken.vercel.app/ogp.png`,
          width: 1200,
          height: 630,
        },
      ],
    },
    twitter: {
      card: 'summary_large_image',
      title: 'えがけん記録',
      description: 'イラスト練習の記録',
      images: [`https://egaken.vercel.app/ogp.png`],
    },
  };
}
