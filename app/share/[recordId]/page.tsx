



export const revalidate = 0; // キャッシュ無効化


import React from 'react';

// Firestoreデータ型
interface Post {
  id: string;
  title: string;
  comment?: string;
  minutes?: number;
  aiComment?: string;
  imageUrl?: string;
  createdAt?: any;
}

// Next.js 15+ PageProps型
interface PageProps {
  params: Promise<{ recordId: string }>;
  searchParams: Promise<{ v?: string }>;
}

// クライアントコンポーネント用Props型
interface SharePostClientProps {
  initialData: Post | null;
  recordId: string;
  version: string;
}

export async function generateMetadata({ params, searchParams }: PageProps): Promise<Metadata> {
  const { recordId } = await params;
  const { v } = await searchParams;
  let imageUrl: string = 'https://egaken.vercel.app/ogp.png';
  let title: string = 'えがけん記録';
  let description: string = 'イラスト練習の記録';
  try {
    const ref = doc(db, 'posts', recordId);
    const snap = await getDoc(ref);
    if (snap.exists()) {
      const data = snap.data() as Post;
      if (typeof data.imageUrl === 'string' && /^https?:\/\//.test(data.imageUrl)) {
        imageUrl = data.imageUrl;
      }
      if (data.title) title = data.title;
      if (data.comment) description = data.comment;
    }
  } catch (e) {
    console.warn('OGP画像取得失敗:', e);
  }
  const shareUrl = `https://egaken.vercel.app/share/${recordId}?v=${v || Date.now()}`;
  return {
    title,
    description,
    openGraph: {
      title,
      description,
      url: shareUrl,
      type: 'website',
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
      title,
      description,
      images: [imageUrl],
    },
  };
}

export default async function SharePage({ params, searchParams }: PageProps): Promise<JSX.Element> {
  const { recordId } = await params;
  const { v } = await searchParams;
  let initialData: Post | null = null;
  try {
    const ref = doc(db, 'posts', recordId);
    const snap = await getDoc(ref);
    if (snap.exists()) {
      const data = snap.data() as Post;
      initialData = { ...data, id: recordId };
    }
  } catch {}
  const version: string = v || `${Date.now()}`;
  const props: SharePostClientProps = {
    initialData,
    recordId,
    version,
  };
  return <SharePostClient {...props} />;
}
