export const dynamic = 'force-dynamic';

import type { Metadata } from 'next';
import SharePostClient from './SharePostClient';

export async function generateMetadata(
  { params }: { params: { recordId: string } }
): Promise<Metadata> {
  const shareUrl = `https://egaken.vercel.app/share/${params.recordId}`;
  const imageUrl = `https://egaken.vercel.app/api/og/${params.recordId}`;

  return {
    title: 'えがけん記録',
    description: 'お絵描きの記録を共有しました',
    openGraph: {
      title: 'えがけん記録',
      description: 'お絵描きの記録を共有しました',
      url: shareUrl,
      type: 'article',
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
      description: 'お絵描きの記録を共有しました',
      images: [imageUrl],
    },
  };
}

export default function Page({ params }: { params: { recordId: string } }) {
  return <SharePostClient recordId={params.recordId} />;
}
