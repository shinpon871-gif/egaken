// app/nine/[shareId]/page.tsx
import React from "react"
import { adminDb } from "@/lib/firebaseAdmin"

type Props = {
  params: Promise<{ shareId?: string }> // params が Promise になっている場合
}

const NineSharePage = async ({ params }: Props) => {
  // ✅ params を await して解決
  const resolvedParams = await params
  const shareId = resolvedParams.shareId?.trim() // 空白除去

  if (!shareId) {
    return (
      <div className="p-6 text-center text-red-500">
        Share ID が指定されていません
      </div>
    )
  }

  if (!adminDb) {
    return (
      <div className="p-6 text-center text-red-500">
        サーバー側で Firestore が初期化されていません
      </div>
    )
  }

  try {
    // adminDb は上のチェックで存在することを保証しているので非 null アサーションを使う
    const db = adminDb!
    const docSnap = await db.collection("nineShares").doc(shareId).get()

    if (!docSnap.exists) {
      return (
        <div className="p-6 text-center text-gray-500">
          画像が見つかりません
        </div>
      )
    }

    const data = docSnap.data() as any

    // Firestore に保存された画像情報を安全に取り出す
    // 可能性のある形:
    // - data.imageDataUrl (string, data:image/png;base64,...)
    // - data.imageUrls (string[] or Array)
    // - data.imageUrl (string)
    let imageUrl = ""

    if (typeof data?.imageDataUrl === "string" && data.imageDataUrl) {
      imageUrl = data.imageDataUrl
    } else if (Array.isArray(data?.imageUrls) && data.imageUrls.length > 0) {
      imageUrl = data.imageUrls[0]
    } else if (typeof data?.imageUrls === "object" && data.imageUrls?.values) {
      // Firestore REST-like structure (念のため)
      const vals = data.imageUrls.values
      if (Array.isArray(vals) && vals.length > 0 && vals[0].stringValue) {
        imageUrl = vals[0].stringValue
      }
    } else if (typeof data?.imageUrl === "string") {
      imageUrl = data.imageUrl
    }

    // サイトのベースURLは環境変数経由で安全に設定可能にする（なければ既知のデフォルトを使う）
    const siteBase =
      (process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/+$/, "") as string) ||
      "https://egaken.vercel.app"
    const pageUrl = `${siteBase}/nine/${encodeURIComponent(shareId)}`

    return (
      <div className="max-w-xs mx-auto py-8 px-4">
        <h1 className="text-xl font-bold mb-4 text-center">9選画像</h1>

        {imageUrl ? (
          <img
            src={imageUrl}
            alt="9選画像"
            className="w-full rounded-lg shadow mb-4"
            style={{ maxWidth: 300, width: "100%" }}
          />
        ) : (
          <div className="text-center text-gray-500">画像が見つかりません</div>
        )}

        <div className="flex justify-center mb-2">
          {/* docSnap.exists が true の場合のみ有効な投稿リンクを出す */}
          <a
            href={`https://twitter.com/intent/tweet?text=${encodeURIComponent(
              "#えがけん最近描いた絵9選"
            )}&url=${encodeURIComponent(pageUrl)}`}
            target="_blank"
            rel="noopener noreferrer"
            className={`inline-block bg-blue-500 hover:bg-blue-600 text-white font-bold py-2 px-6 rounded ${
              !docSnap.exists ? "opacity-50 pointer-events-none" : ""
            }`}
          >
            X（Twitter）で投稿
          </a>
        </div>

        <div className="text-center text-gray-400 text-xs">
          <span>Share ID: {shareId}</span>
        </div>
      </div>
    )
  } catch (err) {
    console.error("[NineSharePage] Firestore 取得エラー:", err)
    return (
      <div className="p-6 text-center text-red-500">
        サーバーエラーが発生しました（ログを確認してください）
      </div>
    )
  }
}

export default NineSharePage