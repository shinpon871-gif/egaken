


export const revalidate = 0; // キャッシュ無効化

import SharePostClient from '@/components/SharePostClient';
import { Metadata } from 'next';
import { doc, getDoc } from 'firebase/firestore';
import { db } from '@/lib/firebase';

type Post = {
  id: string;
  title: string;
  comment?: string;
  minutes?: number;
  aiComment?: string;
  imageUrl?: string;
  createdAt?: any;
};

type Props = {
  params: { recordId: string };
  searchParams?: { v?: string };
};

export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
  const recordId = params.recordId;
  const v = searchParams?.v || `${Date.now()}`;
  let imageUrl = 'https://egaken.vercel.app/ogp.png';
  let title = 'えがけん記録';
  let description = 'イラスト練習の記録';
  try {
    const ref = doc(db, 'posts', recordId);
    const snap = await getDoc(ref);
    if (snap.exists()) {
      const data = snap.data() as Post;
      // Firebase Storageの画像URLは絶対パスで格納されている前提
      if (typeof data.imageUrl === 'string' && /^https?:\/\//.test(data.imageUrl)) {
        imageUrl = data.imageUrl;
      }
      if (data.title) title = data.title;
      if (data.comment) description = data.comment;
    }
  } catch (e) {
    console.warn('OGP画像取得失敗:', e);
  }
  const shareUrl = `https://egaken.vercel.app/share/${recordId}?v=${v}`;
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

export default async function SharePage({ params, searchParams }: Props) {
  const recordId = params.recordId;
  const version = searchParams?.v || `${Date.now()}`;
  let initialData: Post | null = null;
  if (recordId) {
    try {
      const ref = doc(db, 'posts', recordId);
      const snap = await getDoc(ref);
      if (snap.exists()) {
        const data = snap.data() as Post;
        initialData = { ...data, id: recordId };
      }
    } catch {}
  }
  return <SharePostClient initialData={initialData} recordId={recordId} version={version} />;
}
