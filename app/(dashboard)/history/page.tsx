'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import HistoryGrid from '@/components/HistoryGrid'
import { useAuth } from '@/contexts/AuthContext' // ログイン済みユーザー情報を取得するフック

type Post = {
  id: string
  imageUrl: string
}

export default function HistoryPage() {
  const [posts, setPosts] = useState<Post[]>([])
  const [loading, setLoading] = useState(true)

  const { user } = useAuth() // Firebase Auth から現在ログインユーザー取得

  useEffect(() => {
    if (!user?.uid) {
      setLoading(false)
      setPosts([])
      return
    }

    async function loadPosts() {
      try {
        const res = await fetch(`/api/myPosts?uid=${user?.uid}`)
        if (!res.ok) {
          console.error('API error:', await res.text())
          setPosts([])
          return
        }

        const data: { posts: Post[] } = await res.json()
        setPosts(data.posts ?? [])
      } catch (error) {
        console.error('fetch error:', error)
        setPosts([])
      } finally {
        setLoading(false)
      }
    }

    loadPosts()
  }, [user])

  if (loading) return <div className="p-6">読み込み中...</div>
  if (!user) return <div className="p-6">ユーザー情報がありません</div>
  if (!posts.length) return <div className="p-6">投稿がまだありません</div>

  return (
    <div className="p-6">
      <Link href="/" className="inline-flex items-center gap-2 rounded-lg border border-gray-300 px-6 py-3 font-semibold text-gray-700 transition hover:bg-gray-50 mb-4">
        <span>←</span>
        ホームに戻る
      </Link>

      {/* ▼ ユーザー向け説明パネル */}
      <div className="mb-6 p-4 bg-blue-50 border border-blue-200 rounded-lg">
        <h2 className="text-lg font-bold text-blue-900 mb-3">📖 この画面の使い方</h2>
        <ul className="space-y-2 text-sm text-blue-800">
          <li className="flex items-start gap-2">
            <span className="text-lg">🖼️</span>
            <span><strong>投稿画像をクリック</strong> → 投稿の詳細ページが開きます</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="text-lg">☑️</span>
            <span><strong>右上のチェックボックスをクリック</strong> → 最大9枚まで「9選画像」用に選択できます（青い枠が表示されます）</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="text-lg">✨</span>
            <span><strong>9枚全て選択したら「9選を生成」ボタン</strong> → 3×3グリッド状に合成した画像が作成され、X(Twitter)でシェアできます</span>
          </li>
        </ul>
      </div>

      <HistoryGrid posts={posts} />
    </div>
  )
}