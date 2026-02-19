import type { Metadata } from 'next';
import SharePostClient from './SharePostClient';

import type { Metadata } from 'next';
import SharePostClient from './SharePostClient';

export const dynamic = 'force-dynamic';

export async function generateMetadata(
  { params }: { params: Promise<{ recordId: string }> }
): Promise<Metadata> {
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
      images: [image],
    },
    twitter: {
      card: 'summary_large_image',
      images: [image],
    },
  };
}

export default async function Page(
  { params }: { params: Promise<{ recordId: string }> }
) {
  const { recordId } = await params;

  return <SharePostClient recordId={recordId} />;
}

export default function Page({
  params,
}: {
  params: { recordId: string };
}) {
  return <SharePostClient recordId={params.recordId} />;
}
