import SharePostClient from './SharePostClient';
import type { Metadata } from 'next';

type Props = {
  params: { recordId: string };
};

export function generateMetadata({ params }: Props): Metadata {
  const recordId = params.recordId;
  const url = `https://egaken.vercel.app/share/${recordId}`;

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
          url: 'https://egaken.vercel.app/ogp.png',
          width: 1200,
          height: 630,
        },
      ],
    },
    twitter: {
      card: 'summary_large_image',
      title: 'えがけん記録',
      description: 'イラスト練習の記録',
      images: ['https://egaken.vercel.app/ogp.png'],
    },
  };
}

// Page コンポーネントは server component として params を受け取る
export default function Page({ params }: Props) {
  return <SharePostClient recordId={params.recordId} />;
}
