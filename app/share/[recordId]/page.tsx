import type { Metadata } from 'next';
import SharePostClient from './SharePostClient';

type Props = {
  params: { recordId: string };
  searchParams: { img?: string };
};

export function generateMetadata({ params, searchParams }: Props): Metadata {
  const fallback = 'https://egaken.vercel.app/ogp.png';
  const image = searchParams?.img
    ? decodeURIComponent(searchParams.img)
    : fallback;

  const url = `https://egaken.vercel.app/share/${params.recordId}`;

  // 変数に格納する
  const metadata: Metadata = {
    title: 'えがけん記録',
    description: 'イラスト練習の記録',
    openGraph: {
      title: 'えがけん記録',
      description: 'イラスト練習の記録',
      url: url,
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
      images: [
        image
      ],
    },
  };

  return metadata;
}

// JSX を安全に扱うため、Turbopack OFF の SWC ビルドで使用
export default function Page({ params }: { params: { recordId: string } }) {
  return (
    <SharePostClient recordId={params.recordId} />
  );
}
