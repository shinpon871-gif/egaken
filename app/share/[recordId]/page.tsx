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
  
  // デフォルト画像（絶対パス）
    let imageUrl = 'https://egaken.vercel.app/ogp.png';
  const title = 'えがけん記録';
  const description = '練習の記録をシェアしました。';

  try {
    const docRef = doc(db, 'posts', recordId);
    const snap = await getDoc(docRef);
    if (snap.exists()) {
      const data = snap.data() as Post;
      if (data.imageUrl) {
        // 【修正ポイント】クローラーが混乱しないよう、imageUrlをそのまま使用。
        // キャッシュバスターが必要なのは「ページURL」であり「画像URL」ではないため。
          imageUrl = data.imageUrl;
      }
    }
  } catch (e) {
    console.error('Metadata Fetch Error:', e);
  }

  // クローラーに「このページのユニークなURL」を教える（ここがキャッシュ対策の肝）
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
            url: imageUrl,
            width: 1200,
            height: 630,
            alt: 'お絵描き記録',
          },
        ],
      type: 'article',
    },
    twitter: {
      card: 'summary_large_image',
        images: [imageUrl],
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

  // データがない場合は、Clientに任せずServer側で「投稿なし」を判定してもよいが、
  // 現状の構成を維持するためPropsを渡す。vも渡すことでクライアント側のURL生成と同期。
  return <SharePostClient recordId={recordId} initialData={initialData} v={v} />;
}