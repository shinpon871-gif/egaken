





export const revalidate = 0; // キャッシュ無効化

import type { Metadata } from 'next';
import SharePostClient from '@/components/SharePostClient';
import { doc, getDoc } from 'firebase/firestore';
import { db } from '@/lib/firebase';

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
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}

// クライアントコンポーネント用Props型
interface SharePostClientProps {
  initialData: Post | null;
  recordId: string;
  version: string;
}

  const { recordId } = await params;
  const { v } = await searchParams;
  let imageUrl: string = 'https://egaken.vercel.app/ogp.png';

  import { Metadata } from "next";
  import { doc, getDoc } from "firebase/firestore";
  import { db } from "@/lib/firebase";
  import SharePostClient from "@/components/SharePostClient";

  // 1. 型定義 (Next.js 15準拠)
  interface PageProps {
    params: Promise<{ recordId: string }>;
    searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
  }

  interface Post {
    id: string;
    title: string;
    imageUrl: string;
    comment?: string;
    minutes?: number;
    aiComment?: string;
    createdAt?: any;
  }

  // 2. メタデータ生成 (Async Function)
  export async function generateMetadata({ params, searchParams }: PageProps): Promise<Metadata> {
    const { recordId } = await params;
    const { v } = await searchParams;
    let imageUrl: string = "https://egaken.vercel.app/ogp.png";
    let title: string = "えがけん記録";
    let description: string = "イラスト練習の記録";
    try {
      const ref = doc(db, "posts", recordId);
      const snap = await getDoc(ref);
      if (snap.exists()) {
        const data = snap.data() as Post;
        if (typeof data.imageUrl === "string" && /^https?:\/\//.test(data.imageUrl)) {
          imageUrl = data.imageUrl;
        }
        if (data.title) title = data.title;
        if (data.comment) description = data.comment;
      }
    } catch (e) {
      // 取得失敗時はデフォルト値
      console.warn("OGP画像取得失敗:", e);
    }
    const shareUrl = `https://egaken.vercel.app/share/${recordId}?v=${typeof v === "string" ? v : Date.now()}`;
    return {
      title,
      description,
      openGraph: {
        title,
        description,
        url: shareUrl,
        type: "website",
        images: [
          {
            url: imageUrl,
            width: 1200,
            height: 630,
          },
        ],
      },
      twitter: {
        card: "summary_large_image",
        title,
        description,
        images: [imageUrl],
      },
    };
  }

  // 3. ページ本体 (Async Function / 戻り値の型明示禁止)
  export default async function SharePage({ params, searchParams }: PageProps) {
    const { recordId } = await params;
    const { v } = await searchParams;
    let initialData: Post | null = null;
    try {
      const ref = doc(db, "posts", recordId);
      const snap = await getDoc(ref);
      if (snap.exists()) {
        const data = snap.data() as Post;
        initialData = { ...data, id: recordId };
      }
    } catch {}
    const version: string = typeof v === "string" ? v : `${Date.now()}`;
    return <SharePostClient initialData={initialData} recordId={recordId} version={version} />;
  }
