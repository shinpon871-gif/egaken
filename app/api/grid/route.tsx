import { ImageResponse } from "next/og";

export const runtime = "edge";

const PROJECT_ID = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const idsParam = searchParams.get("ids");

    if (!idsParam) {
      return new Response("ids required", { status: 400 });
    }

    const ids = idsParam.split(",");

    if (ids.length !== 9) {
      return new Response("exactly 9 ids required", { status: 400 });
    }

    const urls = await Promise.all(
      ids.map(async (id) => {
        const res = await fetch(
          `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/posts/${id}`
        );

        if (!res.ok) {
          throw new Error("firestore fetch failed");
        }

        const json = await res.json();

        return json.fields.imageUrl.stringValue;
      })
    );

    return new ImageResponse(
      (
        <div
          style={{
            width: "1200px",
            height: "1200px",
            display: "flex",
            flexDirection: "column",
            background: "#ffffff",
          }}
        >
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              width: "1200px",
              height: "1100px",
            }}
          >
            {urls.map((url, i) => (
              <img
                key={i}
                src={url}
                width="400"
                height="366"
                style={{
                  width: "400px",
                  height: "366px",
                  objectFit: "cover",
                }}
              />
            ))}
          </div>

          <div
            style={{
              height: "100px",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <div style={{ fontSize: 48, fontWeight: 700 }}>
              #えがけん最近描いた絵9選
            </div>

            <div style={{ fontSize: 28, color: "#888" }}>
              egaken.vercel.app
            </div>
          </div>
        </div>
      ),
      {
        width: 1200,
        height: 1200,
      }
    );
  } catch (error) {
    console.error(error);
    return new Response("server error", { status: 500 });
  }
}