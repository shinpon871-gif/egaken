'use client'

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
  return (
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
      {posts.map((post) => (
        <div
          key={post.id}
          className="relative aspect-square overflow-hidden rounded-lg border"
        >
          <img
            src={post.imageUrl}
            alt="post"
            className="w-full h-full object-cover"
          />
          {post.isTopNine && (
            <span className="absolute top-2 left-2 bg-yellow-400 text-black px-1 text-xs font-bold rounded">
              ９選
            </span>
          )}
        </div>
      ))}
    </div>
  )
}