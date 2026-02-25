'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { CreateRecordForm } from '@/components/CreateRecordForm';
import { RecordList } from '@/components/RecordList';
import { StatsDisplay } from '@/components/StatsDisplay';

export default function HomePage() {
  const router = useRouter();
  const [showForm, setShowForm] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  const handleSuccess = () => {
    setShowForm(false);
    // リストを更新
    setRefreshKey((prev) => prev + 1);
  };

  return (
    <div className="space-y-8 py-4">
      {/* 統計情報表示 */}
      <StatsDisplay />

      {/* デバッグリンク （開発時のみ） */}
      {/*
      <div className="text-center">
        <a
          href="/debug-storage"
          className="text-xs text-gray-500 hover:text-gray-700 underline"
        >
          🔧 Firebase ストレージデバッグ
        </a>
      </div>
      */}

      {/* CTA ボタン */}
      <div className="flex flex-col gap-3 sm:flex-row sm:justify-center sm:items-stretch w-full max-w-3xl mx-auto">
        {!showForm && (
          <>
            <button
              onClick={() => setShowForm(true)}
              className="flex-1 min-w-[120px] inline-flex items-center justify-center gap-1 rounded-lg bg-orange-500 px-3 py-2 text-sm font-semibold text-white shadow-md transition hover:bg-orange-600 active:scale-95 text-center"
            >
              <span className="text-lg">✏️</span>
              今日の記録
            </button>
            <button
              onClick={() => router.push('/history')}
              className="flex-1 min-w-[120px] inline-flex items-center justify-center gap-1 rounded-lg bg-cyan-500 px-3 py-2 text-sm font-semibold text-white shadow-md transition hover:bg-cyan-600 active:scale-95 text-center"
            >
              <span className="text-lg">🖼️</span>
              ヒストリー
            </button>
            <button
              onClick={() => router.push('/growth')}
              className="flex-1 min-w-[120px] inline-flex items-center justify-center gap-1 rounded-lg bg-purple-500 px-3 py-2 text-sm font-semibold text-white shadow-md transition hover:bg-purple-600 active:scale-95 text-center"
            >
              <span className="text-lg">📊</span>
              成長を見る
            </button>
            <button
              onClick={() => router.push('/profile')}
              className="flex-1 min-w-[120px] inline-flex items-center justify-center gap-1 rounded-lg bg-gray-500 px-3 py-2 text-sm font-semibold text-white shadow-md transition hover:bg-gray-600 active:scale-95 text-center"
            >
              <span className="text-lg">⚙️</span>
              アカウント設定
            </button>
          </>
        )}
      </div>

      {/* 記録作成フォーム */}
      {showForm && (
        <section className="mb-8">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-2xl font-bold text-gray-800">新しい記録</h2>
            <button
              onClick={() => setShowForm(false)}
              className="text-gray-500 transition hover:text-gray-700"
            >
              ✕
            </button>
          </div>
          <CreateRecordForm onSuccess={handleSuccess} />
        </section>
      )}

      {/* 記録一覧 */}
      <section>
        <RecordList key={refreshKey} />
      </section>
    </div>
  );
}
