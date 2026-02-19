import type { Metadata } from 'next';
import SharePostClient from './SharePostClient';
import { getPostById } from '@/lib/getPost';

type Props = {
  params: {
    recordId: string;
  };
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const post = await getPostById(params.recordId);

  const image =
    post?.imageUrl || 'https://egaken.vercel.app/ogp.png';
  const title = post?.title || 'えがけん記録';
  const description = post?.comment || 'イラスト練習の記録';
  const url = `https://egaken.vercel.app/share/${params.recordId}`;

  return {
    title,
    description,
    openGraph: {
      title,
      description,
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
      title,
      description,
      images: [image],
    },
  };
}

export default function Page({ params }: Props) {
  return <SharePostClient recordId={params.recordId} />;
}
