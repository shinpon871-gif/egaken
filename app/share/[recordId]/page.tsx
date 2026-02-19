
export const runtime = 'nodejs';
import type { Metadata } from 'next';
import SharePostClient from './SharePostClient';


type Props = {
  params: {
    recordId: string;
  };
};

// firebase-admin未導入時も安全な画像取得
async function getImageSafe(recordId: string): Promise<string> {
  try {
    const { getPostById } = await import('@/lib/getPost');
    const post = await getPostById(recordId);
    return post?.imageUrl || 'https://egaken.vercel.app/ogp.png';
  } catch {
    return 'https://egaken.vercel.app/ogp.png';
  }
}


export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const image = await getImageSafe(params.recordId);
  const url = `https://egaken.vercel.app/share/${params.recordId}`;
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

export default function Page({ params }: Props) {
  return <SharePostClient recordId={params.recordId} />;
}
