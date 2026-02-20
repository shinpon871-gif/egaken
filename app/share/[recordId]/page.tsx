





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

    import { Metadata } from "next";
    import { doc, getDoc } from "firebase/firestore";
    import { db } from "@/lib/firebase";
    import SharePostClient from "@/components/SharePostClient";

    interface PageProps {
      params: Promise<{ recordId: string }>;
      searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
    }

    interface Post {
      imageUrl: string;
      comment?: string;
    }

    export async function generateMetadata({ params, searchParams }: PageProps): Promise<Metadata> {
      const { recordId } = await params;
      const { v } = await searchParams;
  
      // デフォルト値
      const title = "えがけん記録";
      const description = "練習の記録をシェアしました。";
      let imageUrl = "https://egaken.vercel.app/ogp.png"; // 絶対パス

      try {
        const docRef = doc(db, "posts", recordId);
        const snap = await getDoc(docRef);
        if (snap.exists()) {
          const data = snap.data() as Post;
          if (data.imageUrl) imageUrl = data.imageUrl;
        }
      } catch (e) {
        console.error("Metadata fetch error:", e);
      }

      return {
        title,
        description,
        openGraph: {
          title,
          description,
          images: [imageUrl],
        },
        twitter: {
          card: "summary_large_image",
          images: [imageUrl],
        },
      };
    }

    export default async function SharePage({ params, searchParams }: PageProps) {
      const { recordId } = await params;
      const { v } = await searchParams;

      // Page本体ではデータ取得失敗・ローディング等は Client Component 側に任せる
      // Server側では最小限の props 渡しに徹する
      return (
        <SharePostClient recordId={recordId} v={v as string | undefined} />
      );
    }
