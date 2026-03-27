// app\api\createNine\route.ts
import { NextResponse } from "next/server"
import sharp from "sharp"
import { adminDb, adminStorage } from "@/lib/firebaseAdmin"

export const runtime = "nodejs"

const storageBucket = process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET

async function createGridTile(buffer: Buffer, cellWidth: number, cellHeight: number) {
  return sharp(buffer)
    .resize(Math.round(cellWidth), Math.round(cellHeight), {
      fit: "cover",
      position: sharp.strategy.attention,
    })
    .toBuffer()
}

export async function POST(req: Request) {
  console.log("[createNine] リクエスト開始")

  try {
    const { postIds } = await req.json()

    if (!postIds || !Array.isArray(postIds) || postIds.length !== 9) {
      console.error("[createNine] postIds検証失敗", postIds?.length)
      return NextResponse.json({ error: "9 posts required" }, { status: 400 })
    }

    console.log("[createNine] postIds検証完了", postIds.length)

    // 画像URL取得
    const imageUrls: string[] = []
    for (const id of postIds) {
      console.log("[createNine] postId取得", id)

      try {
        if (!adminDb) {
          throw new Error("Firestore が初期化されていません")
        }
        const doc = await adminDb.collection("posts").doc(id).get()
        const imageUrl = doc.data()?.imageUrl
        if (!imageUrl) {
          throw new Error(`imageUrl not found for post ${id}`)
        }
        console.log("[createNine] imageUrl", imageUrl)
        imageUrls.push(imageUrl)
      } catch (err) {
        console.error("[createNine] Firestore取得失敗", id, err)
        throw err
      }
    }

    console.log("[createNine] 全imageUrl取得完了", imageUrls.length)

    // 画像をダウンロード（サムネイル化・並列処理）
    const images: Buffer[] = await Promise.all(
      imageUrls.map(async (url) => {
        console.log("[createNine] 元画像URL", url)

        try {
          const res = await fetch(url)
          if (!res.ok) {
            throw new Error(`Image fetch failed: ${res.status}`)
          }
          const arrayBuffer = await res.arrayBuffer()
          const buffer = Buffer.from(arrayBuffer)
          console.log("[createNine] 元画像DL", buffer.length)
          return buffer
        } catch {
          console.error("[createNine] ダウンロード失敗", url)
          console.log("[createNine] 代替画像使用")

          const fallbackBuffer = await sharp({
            create: {
              width: 100,
              height: 100,
              channels: 3,
              background: { r: 238, g: 238, b: 238 }
            }
          }).png().toBuffer()

          return fallbackBuffer
        }
      })
    )

    console.log("[createNine] 全画像ダウンロード完了", images.length)

    // 3x3グリッドで合成
    const width = 1200
    const height = 630
    const cellWidth = width / 3
    const cellHeight = height / 3
    const composites: sharp.OverlayOptions[] = []

    for (let i = 0; i < 9; i++) {
      const col = i % 3
      const row = Math.floor(i / 3)
      const left = col * cellWidth
      const top = row * cellHeight

      console.log("[createNine] 画像配置", i, left, top)

      const resized = await createGridTile(images[i], cellWidth, cellHeight)

      composites.push({
        input: resized,
        left: Math.round(left),
        top: Math.round(top)
      })
    }

    console.log("[createNine] 配置完了", composites.length)

    // 背景白で合成
    const buffer = await sharp({
      create: {
        width: width,
        height: height,
        channels: 3,
        background: { r: 255, g: 255, b: 255 }
      }
    })
      .composite(composites)
      .jpeg({
        quality: 78,
        progressive: true,
        mozjpeg: true,
        chromaSubsampling: "4:2:0"
      })
      .toBuffer()

    console.log("[createNine] 合成完了", buffer.length)
    console.log("[createNine] JPEGサイズ", buffer.length)

    // shareId生成
    const shareId = crypto.randomUUID().slice(0, 8)
    console.log("[createNine] shareId生成", shareId)

    // Firebase Storage にアップロード
    if (!adminStorage) {
      throw new Error("Storage が初期化されていません")
    }

    const filePath = `nineShares/${shareId}.jpg`
    console.log("[createNine] Storage upload", filePath)

    const bucket = adminStorage
    const file = bucket.file(filePath)

    await file.save(buffer, {
      metadata: {
        contentType: "image/jpeg",
        cacheControl: "public, max-age=31536000, immutable"
      }
    })

    await file.makePublic()

    const bucketName = storageBucket || "egaken-b4a7e.appspot.com"
    const publicUrl =
      `https://firebasestorage.googleapis.com/v0/b/${bucketName}/o/${encodeURIComponent(filePath)}?alt=media`
    console.log("[createNine] publicUrl", publicUrl)

    // Firestore に保存
    if (!adminDb) {
      throw new Error("Firestore が初期化されていません")
    }

    const db = adminDb
    const now = new Date().toISOString()

    await db.collection("nineShares").doc(shareId).set({
      postIds: postIds,
      imageUrls: imageUrls,
      imageStoragePath: filePath,
      imageUrl: publicUrl,
      createdAt: now,
      updatedAt: now
    })

    console.log("[createNine] Firestore保存完了", shareId)

    return NextResponse.json({ shareId, imageUrl: publicUrl })
  } catch (err) {
    console.error("[createNine] 処理失敗", err)
    return NextResponse.json({ error: "Failed to create nine share" }, { status: 500 })
  }
}
