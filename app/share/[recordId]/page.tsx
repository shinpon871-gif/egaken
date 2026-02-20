import { Metadata } from 'next';
import SharePostClient from '@/components/SharePostClient';
import { doc, getDoc } from 'firebase/firestore';
import { db } from '@/lib/firebase';

export const revalidate = 0;

interface Post {
  imageUrl?: string;
  comment?: string;
}

type PageProps = {
  params: Promise<{ recordId: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
};

export async function generateMetadata({ params, searchParams }: PageProps): Promise<Metadata> {
  const { recordId } = await params;
  const sParams = await searchParams;
  const v = typeof sParams.v === 'string' ? sParams.v : undefined;
  
  // デフォルト画像（Firestoreが失敗した時の予備）
  let imageUrl = 'https://egaken.vercel.app/ogp.png';
  const title = 'えがけん記録';
  const description = '練習の記録をシェアしました。';

  try {
    const docRef = doc(db, 'posts', recordId);
    const snap = await getDoc(docRef);
    if (snap.exists()) {
      const data = snap.data() as Post;
      // 事実確認：FirestoreのURLが生きているので、そのまま代入
      if (data.imageUrl) {
        imageUrl = data.imageUrl;
      }
    }
  } catch (e) {
    console.error('Metadata Fetch Error:', e);
  }

  // ページ自体のURL（SNSキャッシュ対策にここだけ ?v= をつける）
  const canonicalUrl = `https://egaken.vercel.app/share/${recordId}${v ? `?v=${v}` : ''}`;

  return {
    title,
    description,
    alternates: { canonical: canonicalUrl },
    openGraph: {
      title,
      description,
      url: canonicalUrl,
      images: [
        {
          url: imageUrl, // Firestoreから取得した生のURL
          width: 1200,
          height: 630,
        },
      ],
      type: 'article',
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description,
      images: [imageUrl], // Firestoreから取得した生のURL
    },
  };
}

export default async function SharePage({ params, searchParams }: PageProps) {
  const { recordId } = await params;
  const sParams = await searchParams;
  const v = typeof sParams.v === 'string' ? sParams.v : undefined;

  let initialData: any = null;
  try {
    const docRef = doc(db, 'posts', recordId);
    const snap = await getDoc(docRef);
    if (snap.exists()) {
      initialData = { ...snap.data(), id: recordId };
    }
  } catch (e) {
    console.error('Page Fetch Error:', e);
  }

  return <SharePostClient recordId={recordId} initialData={initialData} v={v} />;
}