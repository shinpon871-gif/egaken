import { ImageResponse } from "next/og"
import type { NextRequest } from "next/server"

export const runtime = "edge"
export const revalidate = 86400

const projectId = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID as string

export async function GET(
  req: NextRequest,
  context: { params: Promise<Record<string, string>> }
): Promise<Response> {

  const params = await context.params
  const shareId = params.shareId

  const docUrl =
    `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/nineShares/${shareId}`

  const doc = await fetch(docUrl, {
    next: { revalidate: 86400 }
  }).then(r => r.json())

  const urls: string[] =
    doc.fields.imageUrls.arrayValue.values.map(
      (v: unknown) => (v as Record<string, unknown>).stringValue
    )

  return new ImageResponse(
    (
      <div
        style={{
          width: 1200,
          height: 1200,
          display: "flex",
          flexWrap: "wrap",
          background: "#ffffff",
          position: "relative"
        }}
      >
        {urls.map((u, i) => (
          <img
            key={i}
            src={u}
            width="400"
            height="400"
            style={{ objectFit: "cover" }}
          />
        ))}

        <div
          style={{
            position: "absolute",
            bottom: 20,
            left: 20,
            fontSize: 48,
            fontWeight: 700
          }}
        >
          #えがけん最近描いた絵9選
        </div>
      </div>
    ),
    {
      width: 1200,
      height: 1200
    }
  )
}