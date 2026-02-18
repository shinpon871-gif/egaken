'use client';

import { useRouter } from 'next/navigation';
import { HistoryGrid } from '@/components/HistoryGrid';

export default function HistoryPage() {
  const router = useRouter();

  return (
    <div className="space-y-6 py-4">
      {/* ヘッダー */}
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold text-gray-800">投稿履歴</h1>
        <button
          onClick={() => router.back()}
          className="text-gray-500 transition hover:text-gray-700"
          title="戻る"
        >
          ✕
        </button>
      </div>

      {/* ヒストリーグリッド */}
      <div>
        <HistoryGrid />
      </div>
    </div>
  );
}
