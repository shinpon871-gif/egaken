import SharePostClient from './SharePostClient';
import type { Metadata } from 'next';

type Props = {
  params: { recordId: string };
};

export function generateMetadata({ params }: Props): Metadata {
  const recordId = params.recordId; // server side で取得
  const url = `https://egaken.vercel.app/share/${recordId}`;
  return {
    title: 'えがけん記録',
    description: 'イラスト練習の記録',
    openGraph: {
      title: 'えがけん記録',
      description: 'イラスト練習の記録',
      url,
      type: 'website',
      images: [{ url: '/ogp.png', width: 1200, height: 630 }],
    },
    twitter: {
      card: 'summary_large_image',
      title: 'えがけん記録',
      description: 'イラスト練習の記録',
      images: ['/ogp.png'],
    },
  };
}

export default function Page({ params }: Props) {
  if (!params.recordId) {
    return <div>Record ID が指定されていません</div>;
  }

  // server component から client component に recordId を渡す
  return <SharePostClient recordId={params.recordId} />;
}
