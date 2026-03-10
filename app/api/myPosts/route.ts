import { NextResponse } from 'next/server'
import { adminDb } from '@/lib/firebaseAdmin'

export async function GET(req: Request) {
  try {
    if (!adminDb) {
      console.error('[API] Firestore 未初期化')
      return NextResponse.json({ posts: [] }, { status: 500 })
    }

    const { searchParams } = new URL(req.url)
    const userId = searchParams.get('uid')

    if (!userId) {
      console.error('[API] uid が指定されていません')
      return NextResponse.json({ posts: [] }, { status: 400 })
    }

    // UID でサーバー側フィルタ：自分の投稿のみ取得
    const snap = await adminDb
      .collection('posts')
      .where('userId', '==', userId)
      .orderBy('createdAt', 'desc')
      .limit(50)
      .get()

    const posts = snap.docs.map((doc) => {
      const data = doc.data()
      return {
        id: doc.id,
        imageUrl: data.imageUrl ?? '',
        // ９選判定：weeklyThemeId があるものをピックアップ
        isTopNine: !!data.weeklyThemeId,
        weeklyThemeTitle: data.weeklyThemeTitle ?? null,
        // 過去投稿に userId がない場合はフラグだけ付与（フロントで自分の投稿として扱える）
        isMissingUserId: !data.userId,
      }
    })

    return NextResponse.json({ posts })
  } catch (err) {
    console.error('[API] 取得エラー', err)
    return NextResponse.json({ posts: [] }, { status: 500 })
  }
}