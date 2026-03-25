import { Metadata } from 'next';
import SharePostClient from '@/components/SharePostClient';
import { doc, getDoc } from 'firebase/firestore';
import { db } from '@/lib/firebase';

export const revalidate = 0;

type PageProps = {
  params: Promise<{ recordId: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
};

export async function generateMetadata({ params, searchParams }: PageProps): Promise<Metadata> {
  const { recordId } = await params;
  const sParams = await searchParams;
  const v = typeof sParams.v === 'string' ? sParams.v : undefined;
  const og = typeof sParams.og === 'string' ? sParams.og : '1'; // og パラメータをチェック（デフォルト: 表示）
  
  const showOgp = og !== '0'; // og=0 の場合のみ非表示
  
  // OGP画像はAPI経由で生成（og パラメータを付与）
  const imageUrl = `https://egaken.vercel.app/api/og/${recordId}`;
  const title = 'えがけん記録';
  const description = '練習の記録をシェアしました。';

  // ページ自体のURL（SNSキャッシュ対策にここだけ ?v= をつける）
  const canonicalUrl = `https://egaken.vercel.app/share/${recordId}${v ? `?v=${v}` : ''}`;

  return {
    title,
    description,
    alternates: { canonical: canonicalUrl },
    openGraph: showOgp
      ? {
          title,
          description,
          url: canonicalUrl,
          images: [
            {
              url: imageUrl,
              width: 1200,
              height: 630,
            },
          ],
          type: 'article',
        }
      : {},
    twitter: showOgp
      ? {
          card: 'summary_large_image',
          title,
          description,
          images: [imageUrl],
        }
      : {
          card: 'summary',
          title,
          description,
        },
  };
}

export default async function SharePage({ params, searchParams }: PageProps) {
  const { recordId } = await params;
  const sParams = await searchParams;
  const v = typeof sParams.v === 'string' ? sParams.v : undefined;

  let initialData: Record<string, unknown> | null = null;
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