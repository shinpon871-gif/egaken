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

  let imageUrl = 'https://egaken.vercel.app/ogp.png';
  const title = 'えがけん記録';
  const description = '練習の記録をシェアしました。';
  const canonicalUrl = `https://egaken.vercel.app/share/${recordId}?v=${v || Date.now()}`;

  try {
    const docRef = doc(db, 'posts', recordId);
    const snap = await getDoc(docRef);
    if (snap.exists()) {
      const data = snap.data() as Post;
      if (data.imageUrl) {
        // 既にトークン等のクエリ(?...)がある場合は & を、なければ ? を使う
        const joiner = data.imageUrl.includes('?') ? '&' : '?';
        imageUrl = v ? `${data.imageUrl}${joiner}v=${v}` : data.imageUrl;
      }
    }
  } catch (e) {
    console.error('OGP Metadata Fetch Error:', e);
  }

  if (!imageUrl.startsWith('https')) {
    imageUrl = 'https://egaken.vercel.app/ogp.png';
  }

  return {
    title,
    description,
    alternates: {
      canonical: canonicalUrl,
    },
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
      title,
      description,
      images: [imageUrl],
    },
  };
}

export default async function SharePage({ params, searchParams }: PageProps) {
  const { recordId } = await params;
  await searchParams; // Next.js 15 await維持

  let initialData: any = null;
  try {
    const docRef = doc(db, 'posts', recordId);
    const snap = await getDoc(docRef);
    if (snap.exists()) {
      initialData = { ...snap.data(), id: recordId };
    }
  } catch (e) {
    console.error('Page Data Fetch Error:', e);
  }

  return <SharePostClient recordId={recordId} initialData={initialData} />;
}