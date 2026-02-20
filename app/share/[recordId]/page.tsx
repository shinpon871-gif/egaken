import { Metadata } from 'next';
import SharePostClient from '@/components/SharePostClient';
import { doc, getDoc } from 'firebase/firestore';
import { db } from '@/lib/firebase';

export const revalidate = 0;

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

// NEXT.JS 15準拠: paramsとsearchParamsはPromise型
type PageProps = {
  params: Promise<{ recordId: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
};

// OGP画像生成用
export async function generateMetadata({ params, searchParams }: PageProps): Promise<Metadata> {
  const { recordId } = await params;
  const sParams = await searchParams;
  const v = typeof sParams.v === 'string' ? sParams.v : undefined;
  
  let imageUrl = 'https://egaken.vercel.app/ogp.png';

  try {
    const docRef = doc(db, 'posts', recordId);
    const snap = await getDoc(docRef);
    if (snap.exists()) {
      const data = snap.data() as Post;
      if (data.imageUrl) {
        // Firebase Storage URLにクエリを追加する場合は、既存の?の有無を確認
        const separator = data.imageUrl.includes('?') ? '&' : '?';
        imageUrl = v ? `${data.imageUrl}${separator}v=${encodeURIComponent(v)}` : data.imageUrl;
      }
    }
  } catch (e) {
    console.error("OGP Metadata Error:", e);
  }

  const title = 'えがけん記録';
  const description = '練習の記録をシェアしました。';

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

// サーバーコンポーネント本体
export default async function SharePage({ params, searchParams }: PageProps) {
  const { recordId } = await params;
  // searchParamsは不要ならawaitだけでOK、使うなら展開
  await searchParams;

  let initialData: Post | null = null;
  try {
    const docRef = doc(db, 'posts', recordId);
    const snap = await getDoc(docRef);
    if (snap.exists()) {
      const data = snap.data() as Post;
      initialData = { ...data, id: recordId };
    }
  } catch (e) {
    console.error("Page Data Fetch Error:", e);
  }

  return <SharePostClient recordId={recordId} initialData={initialData} />;
}