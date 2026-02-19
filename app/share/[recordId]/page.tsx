import type { Metadata } from 'next';
import SharePostClient from './SharePostClient';

type Props = {
  params: { recordId: string };
  searchParams?: { img?: string };
};

export function generateMetadata({ params, searchParams }: Props): Metadata {
  const fallbackImage = 'https://egaken.vercel.app/ogp.png';
  const image = searchParams?.img ? decodeURIComponent(searchParams.img) : fallbackImage;

  const recordId = params?.recordId ?? '';
  const url = recordId ? `https://egaken.vercel.app/share/${recordId}` : 'https://egaken.vercel.app/';

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
          url: image,
          width: 1200,
          height: 630,
        },
      ],
    },
    twitter: {
      card: 'summary_large_image',
      title: 'えがけん記録',
      description: 'イラスト練習の記録',
      images: [image],
    },
  };
}

export default function Page({ params }: { params: { recordId: string } }) {
  if (!params?.recordId) {
    return <div>Record ID が指定されていません</div>;
  }

  return <SharePostClient recordId={params.recordId} />;
}
