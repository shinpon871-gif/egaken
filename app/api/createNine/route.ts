import { NextResponse } from "next/server"
import sharp from "sharp"

export const runtime = "nodejs"

const projectId = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID

export async function POST(req: Request) {
  const { postIds } = await req.json()

  if (!postIds || !Array.isArray(postIds) || postIds.length !== 9) {
    return NextResponse.json({ error: "9 posts required" }, { status: 400 })
  }

  // 画像URL取得
  const imageUrls: string[] = await Promise.all(
    postIds.map(async (id: string) => {
      const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/posts/${id}`
      const doc = await fetch(url).then(r => r.json())
      return doc.fields.imageUrl.stringValue
    })
  )

  // 画像をダウンロード
  const images: Buffer[] = await Promise.all(
    imageUrls.map(async (url: string) => {
      try {
        const res = await fetch(url)
        const arrayBuffer = await res.arrayBuffer()
        return Buffer.from(arrayBuffer)
      } catch {
        // 失敗時はグレー画像
        return await sharp({
          create: {
            width: 100,
            height: 100,
            channels: 3,
            background: { r: 238, g: 238, b: 238 }
          }
        }).png().toBuffer()
      }
    })
  )

  // 3x3グリッドで合成
  const size = 300        // 全体 300px
  const cell = 100        // 1セル 100px
  const composites: sharp.OverlayOptions[] = []

  for (let i = 0; i < 9; i++) {
    composites.push({
      input: await sharp(images[i]).resize(cell, cell).toBuffer(),
      left: (i % 3) * cell,
      top: Math.floor(i / 3) * cell
    })
  }

  // 背景白
  let base = sharp({
    create: {
      width: size,
      height: size,
      channels: 3,
      background: { r: 255, g: 255, b: 255 }
    }
  }).png()

  // 合成
  base = base.composite(composites)

  // PNGバッファ
  const buffer = await base.png().toBuffer()

  // shareId生成
  const shareId = crypto.randomUUID().replace(/-/g, "").slice(0, 8)

  // Firestore nineSharesに保存
  const saveUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/nineShares/${shareId}`

  // Base64で保存
  const imageBase64 = buffer.toString('base64')
  const imageDataUrl = `data:image/png;base64,${imageBase64}`

  await fetch(saveUrl, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      fields: {
        postIds: { arrayValue: { values: postIds.map((id: string) => ({ stringValue: id })) } },
        imageUrls: { arrayValue: { values: imageUrls.map((u: string) => ({ stringValue: u })) } },
        imageDataUrl: { stringValue: imageDataUrl },
        createdAt: { timestampValue: new Date().toISOString() }
      }
    })
  })

  return NextResponse.json({ shareId })
}