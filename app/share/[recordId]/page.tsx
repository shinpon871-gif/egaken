
import type { Metadata } from 'next';
import SharePostClient from './SharePostClient';

type Props = {
  params: {
    recordId: string;
  };
  searchParams: {
    img?: string;
    hash?: string;
  };
};

// 短縮URLから画像URLを取得する関数（メモリMap利用）
function getImageFromHash(hash?: string): string {
  if (!hash) return 'https://egaken.vercel.app/ogp.png';
  // サーバー側のグローバルMapを参照（route.tsで管理）
  if (typeof globalThis !== 'undefined' && globalThis.__imageMap) {
    const url = globalThis.__imageMap.get(hash);
    if (url) return url;
  }
  // 見つからなければフォールバック
  return 'https://egaken.vercel.app/ogp.png';
}

export function generateMetadata({ params, searchParams }: Props): Metadata {
  const fallback = 'https://egaken.vercel.app/ogp.png';
  let image = fallback;
  if (searchParams.img) {
    image = decodeURIComponent(searchParams.img);
  } else if (searchParams.hash) {
    image = getImageFromHash(searchParams.hash);
  }
  const url = `https://egaken.vercel.app/share/${params.recordId}`;
  return {
    title: 'えがけん記録',
    description: 'イラスト練習の記録',
    openGraph: {
      title: 'えがけん記録',
      description: 'イラスト練習の記録',
      url,
      type: 'website',
      images: [{ url: image, width: 1200, height: 630 }],
    },
    twitter: {
      card: 'summary_large_image',
      title: 'えがけん記録',
      description: 'イラスト練習の記録',
      images: [image],
    },
  };
}

export default function Page({ params }: Props) {
  return <SharePostClient recordId={params.recordId} />;
}
