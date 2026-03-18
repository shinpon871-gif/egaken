import { NextResponse } from "next/server";
import { adminDb } from "@/lib/firebaseAdmin";

export async function GET() {
  try {
    console.log("[debug-theme] adminDb:", adminDb);

    if (!adminDb) {
      console.error("[debug-theme] adminDb が undefined");
      return NextResponse.json({ 
        error: "Admin DB is not initialized"
      }, { status: 500 });
    }

    console.log("[debug-theme] Firestore クエリ実行");
    const snap = await adminDb.collection("weeklyThemes").get();
    
    console.log("[debug-theme] クエリ完了:", snap.size);

    if (snap.empty) {
      return NextResponse.json({ 
        message: "No themes found",
        themes: []
      }, { status: 200 });
    }

    const themes = snap.docs.map(doc => {
      const data = doc.data();
      return {
        id: doc.id,
        title: data.title,
        startAt: {
          iso: data.startAt?.toDate?.().toISOString?.() || null,
          timestamp: data.startAt?.toMillis?.() || null,
        },
        endAt: {
          iso: data.endAt?.toDate?.().toISOString?.() || null,
          timestamp: data.endAt?.toMillis?.() || null,
        },
      };
    });

    const now = new Date();
    return NextResponse.json({
      currentTime: now.toISOString(),
      currentTimeMs: now.getTime(),
      themes,
    });
  } catch (e) {
    console.error("[debug-theme] エラー詳細:", e);
    return NextResponse.json({ 
      error: String(e),
      errorType: e instanceof Error ? e.constructor.name : typeof e,
      errorCode: (e as any)?.code
    }, { status: 500 });
  }
}
