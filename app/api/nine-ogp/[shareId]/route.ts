
import { NextRequest } from "next/server";
import { adminDb, adminStorage } from "@/lib/firebaseAdmin";
import sharp from "sharp";

export const runtime = "nodejs";

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ shareId: string }> }
) {
  const { shareId } = await context.params;

  if (!shareId) {
    return new Response("Not Found", { status: 404 });
  }
  if (!adminDb || !adminStorage) {
    return new Response("Firebase Admin 未初期化", { status: 500 });
  }

  // Firestoreから9枚画像URL取得
  const doc = await adminDb.collection("nineShares").doc(shareId).get();
  if (!doc.exists) {
    return new Response("Share not found", { status: 404 });
  }
  const data = doc.data();
  const imageUrls: string[] = data?.images ?? [];
  if (!Array.isArray(imageUrls) || imageUrls.length !== 9) {
    return new Response("9 images required", { status: 404 });
  }

  // Firebase Storageの保存先
  const outputPath = `nineShares/${shareId}.jpg`;
  const bucket = adminStorage;
  const file = bucket.file(outputPath);

  // 既に存在する場合はそのまま公開URL返す
  const [exists] = await file.exists();
  if (exists) {
    const publicUrl = `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(outputPath)}?alt=media`;
    return new Response(JSON.stringify({ url: publicUrl }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    // 画像をダウンロード
    const buffers = await Promise.all(
      imageUrls.map(async (url) => {
        const res = await fetch(url);
        if (!res.ok) throw new Error("Image fetch failed");
        return Buffer.from(await res.arrayBuffer());
      })
    );

    // 3x3で合成（各画像正方形300x300px）
    const size = 300;
    const composite: sharp.OverlayOptions[] = [];
    for (let i = 0; i < 9; i++) {
      const x = (i % 3) * size;
      const y = Math.floor(i / 3) * size;
      composite.push({ input: buffers[i], left: x, top: y });
    }
    const canvas = sharp({
      create: {
        width: size * 3,
        height: size * 3,
        channels: 3,
        background: { r: 255, g: 255, b: 255 },
      },
    });
    const merged = await canvas.composite(composite).jpeg().toBuffer();

    // Firebase Storageに保存
    await file.save(merged, {
      contentType: "image/jpeg",
      public: true,
      metadata: { cacheControl: "public, max-age=31536000" },
    });

    // 公開URL返す
    const publicUrl = `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(outputPath)}?alt=media`;
    return new Response(JSON.stringify({ url: publicUrl }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("[nine-ogp] Error:", err);
    return new Response("Internal Server Error", { status: 500 });
  }
}