// components/HistoryGrid.tsx
'use client'

import React, { useState } from 'react'
import { useRouter } from 'next/navigation'

type Post = {
  id: string
  imageUrl: string
  isTopNine?: boolean
  weeklyThemeTitle?: string | null
}

type Props = {
  posts: Post[]
}

export default function HistoryGrid({ posts }: Props) {
  const [selected, setSelected] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const router = useRouter()

  const toggleSelect = (id: string) => {
    setSelected((prev) =>
      prev.includes(id)
        ? prev.filter((pid) => pid !== id)
        : prev.length < 9
        ? [...prev, id]
        : prev
    )
  }

  const handleCreateNine = async () => {
    if (selected.length !== 9) return
    setLoading(true)
    try {
      const res = await fetch('/api/createNine', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ postIds: selected }),
      })
      if (!res.ok) throw new Error('生成に失敗しました')
      const data = await res.json()
      if (data.shareId) {
        router.push(`/nine/${data.shareId}`)
      }
    } catch (e) {
      alert('9選画像の生成に失敗しました')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div>
      <div
        className="
          grid
          grid-cols-2
          sm:grid-cols-3
          md:grid-cols-4
          lg:grid-cols-5
          gap-4
        "
      >
        {posts.map((post) => {
          const checked = selected.includes(post.id)
          const disabled = !checked && selected.length >= 9

          return (
            <div
              key={post.id}
              className={`relative aspect-square overflow-hidden rounded-lg border ${
                checked ? 'ring-4 ring-blue-400' : ''
              }`}
            >
              {/* ▼ ここ追加：画像クリックで遷移 */}
              <img
                src={post.imageUrl}
                alt="post"
                className="w-full h-full object-cover cursor-pointer"
                onClick={() => router.push(`/record/${post.id}`)}
              />

              {/* ▼ ここ修正：イベント伝播を止める */}
              <input
                type="checkbox"
                className="absolute top-2 right-2 w-5 h-5 accent-blue-500"
                checked={checked}
                disabled={disabled}
                onClick={(e) => e.stopPropagation()}
                onChange={() => toggleSelect(post.id)}
                aria-label="画像を選択"
              />
            </div>
          )
        })}
      </div>

      <div className="mt-6 flex justify-center">
        <button
          className="px-6 py-2 rounded bg-blue-600 text-white font-bold disabled:bg-gray-300"
          disabled={selected.length !== 9 || loading}
          onClick={handleCreateNine}
        >
          {loading ? '生成中...' : '9選を生成'}
        </button>
      </div>

      <div className="mt-2 text-center text-sm text-gray-500">
        {selected.length} / 9 枚選択
      </div>
    </div>
  )
}