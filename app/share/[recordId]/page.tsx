export const dynamic = 'force-dynamic';


import type { Metadata } from 'next';
import SharePostClient from './SharePostClient';

// 診断用: OGP最小構成・外部画像固定
export async function generateMetadata(): Promise<Metadata> {
  return {
    title: 'TEST',
    openGraph: {
      images: [
        {
          url: 'https://ogp.me/logo.png',
          width: 400,
          height: 400,
        },
      ],
    },
    twitter: {
      card: 'summary_large_image',
      images: ['https://ogp.me/logo.png'],
    },
  };
}

export default function Page({ params }: { params: { recordId: string } }) {
  return <SharePostClient recordId={params.recordId} />;
}
