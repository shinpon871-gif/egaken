// app/nine/[shareId]/page.tsx
import { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";

// キャッシュを無効化し、常に最新の状態でレンダリングする設定
export const dynamic = 'force-dynamic';
export const revalidate = false;
export const dynamicParams = true;

interface PageParams {
  shareId: string;
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

export async function generateMetadata(
  { params }: { params: Promise<PageParams> }
): Promise<Metadata> {
  const { shareId } = await params;

  // メタデータ生成のログを出力
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
      type: "website",
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

export default async function SharePage({ params }: { params: Promise<PageParams> }) {
  const { shareId } = await params;
  
  // ページレンダリングのログを出力
  console.log(`[PAGE] Rendering SharePage for shareId: ${shareId}`);
  
  const imageUrl = getNineShareImageUrl(shareId);
  console.log(`[PAGE] Image URL: ${imageUrl}`);

  if (!isValidShareId(shareId)) {
    notFound();
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="border-b border-gray-200 bg-white shadow-sm">
        <div className="max-w-2xl mx-auto px-4 py-4">
          <Link href="/home" className="flex items-center gap-2 hover:opacity-80 transition w-fit">
            <span className="text-2xl">🎨</span>
            <h1 className="text-2xl font-bold text-gray-800">えがけん</h1>
          </Link>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-xs mx-auto py-8 px-4 flex flex-col min-h-[calc(100vh-120px)]">
        <div className="flex-1">
          <h1 className="text-xl font-bold mb-4 text-center">#えがけん最近描いた絵9選</h1>
          <img src={imageUrl} alt="" className="w-full rounded-lg shadow mb-4" style={{ maxWidth: 300, width: "100%" }} />
          <div className="flex justify-center mb-2">
            <a
              href={`https://twitter.com/intent/tweet?text=%23えがけん最近描いた絵9選&url=https://egaken.vercel.app/nine/${shareId}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-block bg-blue-500 hover:bg-blue-600 text-white font-bold py-2 px-6 rounded"
            >
              X（Twitter）で投稿
            </a>
          </div>
          <div className="text-center text-gray-400 text-xs">
            <span>Share ID: {shareId}</span>
          </div>
        </div>

        {/* アクション */}
        <div className="flex gap-3 mt-8">
          <Link href="/" className="flex-1 rounded-lg border border-gray-300 px-4 py-3 font-semibold text-gray-700 transition hover:bg-gray-50 text-center">
            ← ホームに戻る
          </Link>
        </div>
      </main>
    </div>
  );
}
