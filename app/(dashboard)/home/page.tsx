'use client';

import { useState } from 'react';
import { CreateRecordForm } from '@/components/CreateRecordForm';
import { RecordList } from '@/components/RecordList';

// このページはサーバーサイドでプリレンダリングしない
export const dynamic = 'force-dynamic';

export default function HomePage() {
  const [showForm, setShowForm] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  const handleSuccess = () => {
    setShowForm(false);
    // リストを更新
    setRefreshKey((prev) => prev + 1);
  };

  return (
    <div className="space-y-8 py-4">
      {/* CTA ボタン */}
      <div className="text-center">
        {!showForm && (
          <button
            onClick={() => setShowForm(true)}
            className="inline-flex items-center gap-2 rounded-lg bg-orange-500 px-8 py-4 text-lg font-bold text-white shadow-lg transition hover:bg-orange-600 active:scale-95"
          >
            <span className="text-2xl">✏️</span>
            今日の記録
          </button>
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
