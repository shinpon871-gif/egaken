'use client'

import { useEffect, useState } from 'react'
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
    if (!user) {
      setLoading(false) // ユーザーがいない場合もローディングを終了
      setPosts([])
      return
    }

    async function loadPosts() {
      try {
        const res = await fetch(`/api/myPosts?uid=${user?.uid}`) // uid付きでAPI呼び出し
        if (!res.ok) {
          const text = await res.text()
          console.error('API error:', text)
          setPosts([])
          return
        }

        const data = await res.json()
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
      <HistoryGrid posts={posts} />
    </div>
  )
}