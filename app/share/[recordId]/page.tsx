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
  
  let imageUrl = '[https://egaken.vercel.app/ogp.png](https://egaken.vercel.app/ogp.png)';
  const title = 'えがけん記録';
  const description = '練習の記録をシェアしました。';

  try {
    const docRef = doc(db, 'posts', recordId);
    const snap = await getDoc(docRef);
    if (snap.exists()) {
      const data = snap.data() as Post;
      if (data.imageUrl) {
        // Firebase Storage URLのトークンを壊さないよう結合
        const separator = data.imageUrl.includes('?') ? '&' : '?';
        imageUrl = v ? `${data.imageUrl}${separator}v=${encodeURIComponent(v)}` : data.imageUrl;
      }
    }
  } catch (e) {
    console.error("OGP Metadata Fetch Error:", e);
  }

  return {
    title,
    description,
    openGraph: {
      title,
      description,
      images: [{ url: imageUrl }],
    },
    twitter: {
      card: 'summary_large_image',
      images: [imageUrl],
    },
  };
}

export default async function SharePage({ params, searchParams }: PageProps) {
  const { recordId } = await params;
  const sParams = await searchParams; // Await even if not used to satisfy Next.js 15
  
  let initialData: any = null;
  try {
    const docRef = doc(db, 'posts', recordId);
    const snap = await getDoc(docRef);
    if (snap.exists()) {
      initialData = { ...snap.data(), id: recordId };
    }
  } catch (e) {
    console.error("Page Data Fetch Error:", e);
  }

  return <SharePostClient recordId={recordId} initialData={initialData} />;
}