
import { Metadata } from 'next';
import SharePostClient from './SharePostClient';

type Props = {
  params: { recordId: string };
  searchParams?: { v?: string };
};

export function generateMetadata({ params }: Props): Metadata {
  const recordId = params.recordId ?? '';
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
      images: [`https://egaken.vercel.app/ogp.png`],
    },
  };
}

export default function SharePage({ params, searchParams }: Props) {
  const recordId = params.recordId;
  const version = searchParams?.v;

  if (!recordId) {
    return <div>Record ID が指定されていません</div>;
  }

  return <SharePostClient recordId={recordId} version={version} />;
}
