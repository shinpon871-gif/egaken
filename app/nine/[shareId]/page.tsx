// app/nine/[shareId]/page.tsx
import { Metadata } from "next";
import { notFound } from "next/navigation";

// キャッシュを無効化し、常に最新の状態でレンダリングする設定
export const dynamic = 'force-dynamic';
export const revalidate = 0;

interface PageProps {
  params: { shareId: string } | Promise<{ shareId: string }>;
}

// Share ID の形式チェック
const isValidShareId = (id: string): boolean => {
  return /^[a-zA-Z0-9-_]+$/.test(id);
};

// 画像URL生成ロジックの共通化
const getNineShareImageUrl = (shareId: string) => {
  // 必ず nineShares フォルダを参照する
  return `https://firebasestorage.googleapis.com/v0/b/egaken-b4a7e.firebasestorage.app/o/nineShares%2F${shareId}.jpg?alt=media`;
};

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const resolvedParams = await (params instanceof Promise ? params : Promise.resolve(params));
  const { shareId } = resolvedParams;

  // デバッグ用ログ
  console.log(`[METADATA] Generating metadata for shareId: ${shareId}`);

  if (!isValidShareId(shareId)) {
    return { title: "ページが見つかりません" };
  }

  const imageUrl = getNineShareImageUrl(shareId);
  console.log(`[METADATA] OGP Image URL: ${imageUrl}`);

  return {
    title: "えがけん - 9選画像",
    description: "最近描いた9枚の絵",
    openGraph: {
      title: "えがけん - 9選画像",
      description: "最近描いた9枚の絵",
      url: `https://egaken.vercel.app/nine/${shareId}`,
      images: [{ url: imageUrl, width: 1200, height: 630, alt: "9選合成画像" }],
    },
    twitter: {
      card: "summary_large_image",
      title: "えがけん",
      description: "最近描いた9枚の絵",
      images: [imageUrl],
    },
  };
}

export default async function SharePage({ params }: PageProps) {
  const resolvedParams = await (params instanceof Promise ? params : Promise.resolve(params));
  const { shareId } = resolvedParams;
  
  // デバッグ用ログ：サーバーのコンソールを確認してください
  console.log(`Rendering SharePage for ID: ${shareId}`);
  const imageUrl = getNineShareImageUrl(shareId);
  console.log(`Generated Image URL: ${imageUrl}`);

  if (!isValidShareId(shareId)) {
    notFound();
  }

  return (
    <div style={{ padding: '20px', border: '10px solid red', backgroundColor: 'lightyellow' }}>
      <h1 style={{ fontSize: '24px', fontWeight: 'bold', color: 'red' }}>【最終テスト】このファイルが読み込まれています</h1>
      <p>Share ID: {shareId}</p>
      <p>画像URL:</p>
      <textarea readOnly style={{ width: '100%', height: '100px', border: '1px solid black' }} defaultValue={imageUrl} />
      <img src={imageUrl} alt="9選合成画像" style={{ width: '100%', border: '5px solid blue', marginTop: '10px' }} />
    </div>
  );
}