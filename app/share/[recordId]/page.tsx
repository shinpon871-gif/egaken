import type { Metadata } from 'next';
import SharePostClient from './SharePostClient';

type Props = {
  params: Promise<{
    recordId: string;
  }>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { recordId } = await params;

  const url = `https://egaken.vercel.app/share/${recordId}`;
  const image = 'https://egaken.vercel.app/ogp.png';

  return {
    title: 'えがけん記録',
    description: 'イラスト練習の記録',
    openGraph: {
      title: 'えがけん記録',
      description: 'イラスト練習の記録',
      url,
      images: [
        {
          url: image,
          width: 1200,
          height: 630,
        },
      ],
      type: 'website',
    },
    twitter: {
      card: 'summary_large_image',
      title: 'えがけん記録',
      description: 'イラスト練習の記録',
      images: [image],
    },
  };
}

export default async function Page({ params }: Props) {
  const { recordId } = await params;
  return <SharePostClient recordId={recordId} />;
}
