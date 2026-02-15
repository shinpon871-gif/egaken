'use client';

import { useEffect, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { db } from '@/lib/firebase';
import {
  collection,
  query,
  where,
  orderBy,
  onSnapshot,
  deleteDoc,
  doc,
  Timestamp,
} from 'firebase/firestore';
import Image from 'next/image';

interface Record {
  id: string;
  userId: string;
  imageUrl: string;
  comment: string;
  practiceMinutes: number;
  createdAt: Timestamp | null;
}

interface RecordListProps {
  refresh?: boolean;
}

export function RecordList({ refresh }: RecordListProps) {
  const { user } = useAuth();
  const [records, setRecords] = useState<Record[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [indexUrl, setIndexUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;

    const q = query(
      collection(db, 'records'),
      where('userId', '==', user.uid),
      orderBy('createdAt', 'desc')
    );

    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        const recordsData: Record[] = [];
        snapshot.forEach((doc) => {
          recordsData.push({
            id: doc.id,
            ...(doc.data() as Omit<Record, 'id'>),
          });
        });
        setRecords(recordsData);
        setIsLoading(false);
      },
      (error) => {
        console.error('リスト取得エラー:', error);
        // Firestore returns a console error with a link when a composite index is required.
        // Extract the URL if present so we can show a helpful UI message.
        try {
          const msg = (error && (error as any).message) || '';
          const m = msg.match(/https:\/\/console\.firebase\.google\.com\/[\w\-\./?=%&,:]*/);
          if (m) setIndexUrl(m[0]);
        } catch (e) {
          // ignore
        }
        setIsLoading(false);
      }
    );

    return () => unsubscribe();
  }, [user, refresh]);

  const handleDelete = async (recordId: string) => {
    if (!confirm('この記録を削除しますか？')) return;

    setDeletingId(recordId);
    try {
      await deleteDoc(doc(db, 'records', recordId));
    } catch (error) {
      console.error('削除エラー:', error);
      alert('削除に失敗しました');
    } finally {
      setDeletingId(null);
    }
  };

  const formatDate = (timestamp: Timestamp | null) => {
    if (!timestamp) return '';
    const date = timestamp.toDate();
    return date.toLocaleDateString('ja-JP', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  if (isLoading) {
    return (
      <div className="flex justify-center py-12">
        <p className="text-gray-600">読み込み中...</p>
      </div>
    );
  }

  if (indexUrl) {
    return (
      <div className="rounded-lg bg-yellow-50 p-6 text-center shadow-md">
        <h3 className="mb-2 text-lg font-semibold text-gray-800">インデックスが必要です</h3>
        <p className="mb-4 text-gray-700">このクエリを実行するには Firestore の複合インデックスが必要です。以下のリンクからインデックスを作成してください。</p>
        <a
          href={indexUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-block rounded bg-blue-600 px-4 py-2 text-white hover:bg-blue-700"
        >
          インデックスを作成する
        </a>
      </div>
    );
  }

  if (records.length === 0) {
    return (
      <div className="rounded-lg bg-white p-12 text-center shadow-md">
        <div className="mb-4 text-5xl">📝</div>
        <h3 className="mb-2 text-lg font-semibold text-gray-800">記録がありません</h3>
        <p className="text-gray-600">今日のお絵描きを記録してみましょう！</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <h2 className="text-2xl font-bold text-gray-800">過去の記録</h2>
      <div className="space-y-4">
        {records.map((record) => (
          <article
            key={record.id}
            className="overflow-hidden rounded-lg bg-white shadow-md transition hover:shadow-lg"
          >
            {/* 画像 */}
            <div className="relative aspect-square w-full overflow-hidden bg-gray-100">
              <Image
                src={record.imageUrl}
                alt={record.comment || '記録'}
                fill
                className="object-cover"
                sizes="(max-width: 640px) 100vw, (max-width: 1024px) 90vw, 600px"
              />
            </div>

            {/* コンテンツ */}
            <div className="p-4">
              <div className="mb-3 flex items-start justify-between">
                <time className="text-sm text-gray-500">
                  {formatDate(record.createdAt)}
                </time>
                <button
                  onClick={() => handleDelete(record.id)}
                  disabled={deletingId === record.id}
                  className="rounded px-2 py-1 text-xs text-red-600 hover:bg-red-50 disabled:opacity-50"
                >
                  {deletingId === record.id ? '削除中...' : '削除'}
                </button>
              </div>

              {record.comment && (
                <p className="mb-3 whitespace-pre-wrap text-gray-700">
                  {record.comment}
                </p>
              )}

              {record.practiceMinutes > 0 && (
                <div className="flex items-center gap-2 rounded-lg bg-orange-50 px-3 py-2 text-sm text-orange-700">
                  <span>⏱️</span>
                  <span>{record.practiceMinutes}分</span>
                </div>
              )}
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}
