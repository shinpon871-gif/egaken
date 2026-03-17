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
      <HistoryGrid posts={posts} />
    </div>
  )
}