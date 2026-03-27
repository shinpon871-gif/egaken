'use client';

import { useEffect, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { db } from '@/lib/firebase';
import { calculateTrainingDays } from '@/lib/utils';
import {
  collection,
  query,
  where,
  orderBy,
  onSnapshot,
  deleteDoc,
  doc,
  Timestamp,
  updateDoc,
  serverTimestamp,
} from 'firebase/firestore';
import { ShareButton } from './ShareButton';

interface Record {
  id: string;
  userId: string;
  imageUrl: string;
  comment: string;
  minutes: number;
  aiComment?: string;
  createdAt: Timestamp | null;
  characterType?: string;
  weeklyThemeId?: string;
  weeklyThemeTitle?: string;
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
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editComment, setEditComment] = useState('');
  const [trainingDays, setTrainingDays] = useState<number>(0);

  useEffect(() => {
    if (!user) return;

    const q = query(
      collection(db, 'posts'),
      where('userId', '==', user.uid),
      orderBy('createdAt', 'desc')
    );

    // trainingDays を計算
    calculateTrainingDays(user.uid).then((days) => {
      setTrainingDays(days);
    }).catch((e) => {
      console.error('calculateTrainingDays failed:', e);
      setTrainingDays(0);
    });

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
        try {
          const msg = (error && (error as unknown as { message?: string }).message) || '';
          const m = msg.match(/https:\/\/console\.firebase\.google\.com\/[\w\-\./?=%&,:]*/);
          if (m) setIndexUrl(m[0]);
        } catch {}
        setIsLoading(false);
      }
    );

    return () => unsubscribe();
  }, [user, refresh]);

  const handleDelete = async (recordId: string) => {
    if (!confirm('この記録を削除しますか？')) return;

    setDeletingId(recordId);
    try {
      await deleteDoc(doc(db, 'posts', recordId));
    } catch (error) {
      console.error('削除エラー:', error);
      alert('削除に失敗しました');
    } finally {
      setDeletingId(null);
    }
  };

  const handleEditClick = (record: Record) => {
    setEditingId(record.id);
    setEditComment(record.comment || '');
  };

  const handleCancelEdit = () => {
    setEditingId(null);
    setEditComment('');
  };

  const handleSaveEdit = async (recordId: string) => {
    if (editComment.length > 140) return;

    try {
      await updateDoc(doc(db, 'posts', recordId), {
        comment: editComment,
        updatedAt: serverTimestamp(),
      });
      setEditingId(null);
      setEditComment('');
    } catch (error) {
      console.error('コメント更新エラー:', error);
      alert('コメントの更新に失敗しました');
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

  const getProxyImageUrl = (imageUrl: string) => {
    return `/api/image-proxy?url=${encodeURIComponent(imageUrl)}`;
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
        <h3 className="mb-2 text-lg font-semibold text-gray-800">
          インデックスが必要です
        </h3>
        <p className="mb-4 text-gray-700">
          このクエリを実行するには Firestore の複合インデックスが必要です。
        </p>
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
        <h3 className="mb-2 text-lg font-semibold text-gray-800">
          記録がありません
        </h3>
        <p className="text-gray-600">
          今日のお絵描きを記録してみましょう！
        </p>
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
            className="overflow-hidden rounded-lg bg-white shadow-md hover:shadow-lg"
          >
            <div className="relative aspect-square w-full overflow-hidden bg-gray-100">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={getProxyImageUrl(record.imageUrl)}
                alt=""
                className="w-full h-full object-cover"
                loading="lazy"
              />
            </div>

            <div className="p-4">
              <time className="mb-3 block text-sm text-gray-500">
                {formatDate(record.createdAt)}
              </time>

              {editingId === record.id ? (
                <div className="mb-3 space-y-2">
                  <textarea
                    value={editComment}
                    onChange={(e) => setEditComment(e.target.value)}
                    maxLength={140}
                    className="w-full rounded border border-gray-300 p-2 text-sm focus:border-blue-500 focus:outline-none appearance-none text-gray-900"
                    rows={3}
                  />
                  <p className="text-xs text-gray-500">
                    {editComment.length}/140
                  </p>
                </div>
              ) : (
                record.comment && (
                  <p className="mb-3 whitespace-pre-wrap text-gray-700">
                    {record.comment}
                  </p>
                )
              )}

              {!editingId && (
                <div className="mb-3">
                  <ShareButton
                    recordId={record.id}
                    comment={record.comment}
                    practiceMinutes={record.minutes}
                    themeId={record.weeklyThemeId}
                    themeTitle={record.weeklyThemeTitle}
                    trainingDays={trainingDays}
                  />
                </div>
              )}

              {record.aiComment && (
                <div className="mb-4 p-3 bg-blue-50 rounded-lg border border-blue-100">
                  <span className="font-semibold text-blue-600">えがけん応援コメント</span>
                  <p className="text-gray-700 whitespace-pre-wrap text-sm mt-1">{record.aiComment}</p>
                </div>
              )}

              <div className="flex gap-2">
                {editingId === record.id ? (
                  <>
                    <button
                      onClick={() => handleSaveEdit(record.id)}
                      className="rounded-lg bg-blue-600 px-3 py-2 text-xs font-semibold text-white hover:bg-blue-700"
                    >
                      保存
                    </button>
                    <button
                      onClick={handleCancelEdit}
                      className="rounded-lg px-3 py-2 text-xs font-semibold text-gray-600 hover:bg-gray-50"
                    >
                      キャンセル
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      onClick={() => handleEditClick(record)}
                      className="rounded-lg px-3 py-2 text-xs font-semibold text-gray-600 hover:bg-gray-50"
                    >
                      編集
                    </button>

                    <button
                      onClick={() => handleDelete(record.id)}
                      disabled={deletingId === record.id}
                      className="rounded-lg px-3 py-2 text-xs font-semibold text-red-600 hover:bg-red-50"
                    >
                      削除
                    </button>
                  </>
                )}
              </div>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}