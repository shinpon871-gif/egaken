// app\api\createNine\route.ts
import { NextResponse } from "next/server"
import fs from "fs"
import path from "path"
import sharp from "sharp"
import { ImageAnnotatorClient, protos } from "@google-cloud/vision"
import { adminDb, adminStorage } from "@/lib/firebaseAdmin"

export const runtime = "nodejs"

const storageBucket = process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET
const serviceAccountPath = path.join(
  process.cwd(),
  "egaken-b4a7e-firebase-adminsdk-fbsvc-dacdaab784.json"
)

type FaceAnnotation = protos.google.cloud.vision.v1.IFaceAnnotation

let visionClient: ImageAnnotatorClient | null | undefined

function getVisionClient() {
  if (visionClient !== undefined) {
    return visionClient
  }

  try {
    const serviceAccountKey = process.env.FIREBASE_SERVICE_ACCOUNT_KEY

    if (serviceAccountKey) {
      const credentials = JSON.parse(serviceAccountKey) as {
        client_email?: string
        private_key?: string
        project_id?: string
      }

      if (credentials.private_key) {
        credentials.private_key = credentials.private_key.replace(/\\n/g, "\n")
      }

      visionClient = new ImageAnnotatorClient({
        credentials: {
          client_email: credentials.client_email,
          private_key: credentials.private_key,
        },
        projectId: credentials.project_id,
      })

      return visionClient
    }

    if (fs.existsSync(serviceAccountPath)) {
      visionClient = new ImageAnnotatorClient({
        keyFilename: serviceAccountPath,
      })

      return visionClient
    }
  } catch (error) {
    console.warn("[createNine] Vision client 初期化失敗", error)
  }

  visionClient = null
  return visionClient
}

function getFaceBounds(face: FaceAnnotation) {
  const vertices = face.fdBoundingPoly?.vertices ?? face.boundingPoly?.vertices ?? []
  const points = vertices
    .map((vertex) => ({
      x: typeof vertex?.x === "number" ? vertex.x : 0,
      y: typeof vertex?.y === "number" ? vertex.y : 0,
    }))
    .filter((point, index, array) => {
      if (index === 0) {
        return true
      }

      return point.x !== array[0].x || point.y !== array[0].y
    })

  if (!points.length) {
    return null
  }

  const xs = points.map((point) => point.x)
  const ys = points.map((point) => point.y)

  return {
    left: Math.min(...xs),
    top: Math.min(...ys),
    right: Math.max(...xs),
    bottom: Math.max(...ys),
  }
}

async function detectFaceCenter(buffer: Buffer) {
  const client = getVisionClient()

  if (!client) {
    return null
  }

  try {
    const [result] = await client.faceDetection({ image: { content: buffer } })
    const faces = (result.faceAnnotations ?? [])
      .map(getFaceBounds)
      .filter((face): face is NonNullable<ReturnType<typeof getFaceBounds>> => Boolean(face))

    if (!faces.length) {
      return null
    }

    const combined = faces.reduce(
      (acc, face) => ({
        left: Math.min(acc.left, face.left),
        top: Math.min(acc.top, face.top),
        right: Math.max(acc.right, face.right),
        bottom: Math.max(acc.bottom, face.bottom),
      }),
      faces[0]
    )

    return {
      x: (combined.left + combined.right) / 2,
      y: (combined.top + combined.bottom) / 2,
    }
  } catch (error) {
    console.warn("[createNine] 顔検出失敗。attention クロップへフォールバックします", error)
    return null
  }
}

function clampCropStart(start: number, cropSize: number, maxSize: number) {
  if (cropSize >= maxSize) {
    return 0
  }

  return Math.min(Math.max(0, Math.round(start)), maxSize - cropSize)
}

async function createGridTile(
  buffer: Buffer,
  cellWidth: number,
  cellHeight: number
) {
  const targetWidth = Math.round(cellWidth)
  const targetHeight = Math.round(cellHeight)
  const metadata = await sharp(buffer).metadata()

  if (!metadata.width || !metadata.height) {
    return sharp(buffer)
      .resize(targetWidth, targetHeight, {
        fit: "cover",
        position: sharp.strategy.attention,
      })
      .toBuffer()
  }

  const faceCenter = await detectFaceCenter(buffer)

  if (!faceCenter) {
    return sharp(buffer)
      .resize(targetWidth, targetHeight, {
        fit: "cover",
        position: sharp.strategy.attention,
      })
      .toBuffer()
  }

  const sourceWidth = metadata.width
  const sourceHeight = metadata.height
  const targetAspect = targetWidth / targetHeight
  const sourceAspect = sourceWidth / sourceHeight

  let cropWidth = sourceWidth
  let cropHeight = sourceHeight

  if (sourceAspect > targetAspect) {
    cropWidth = Math.min(sourceWidth, Math.round(sourceHeight * targetAspect))
  } else {
    cropHeight = Math.min(sourceHeight, Math.round(sourceWidth / targetAspect))
  }

  const left = clampCropStart(faceCenter.x - cropWidth / 2, cropWidth, sourceWidth)
  const top = clampCropStart(faceCenter.y - cropHeight / 2, cropHeight, sourceHeight)

  console.log("[createNine] 顔中心クロップ", {
    sourceWidth,
    sourceHeight,
    cropWidth,
    cropHeight,
    left,
    top,
  })

  return sharp(buffer)
    .extract({
      left,
      top,
      width: cropWidth,
      height: cropHeight,
    })
    .resize(targetWidth, targetHeight)
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
