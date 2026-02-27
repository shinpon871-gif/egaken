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
  characterType?: string; // 追加: キャラクタータイプ（optional）
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

  useEffect(() => {
    if (!user) return;

    const q = query(
      collection(db, 'posts'),
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
              <img
                src={getProxyImageUrl(record.imageUrl)}
                alt={record.comment || '記録'}
                className="w-full h-full object-cover"
                loading="lazy"
              />
            </div>

            {/* コンテンツ */}
            <div className="p-4">
              <time className="mb-3 block text-sm text-gray-500">
                {formatDate(record.createdAt)}
              </time>

              {editingId === record.id ? (
                <div className="mb-4 rounded-lg bg-gray-50 p-3">
                  <textarea
                    value={editComment}
                    onChange={(e) => setEditComment(e.target.value)}
                    className="w-full appearance-none rounded border border-gray-300 p-2 text-sm text-gray-900 focus:border-orange-500 focus:outline-none"
                    rows={3}
                    placeholder="コメントを入力..."
                  />
                  <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                    <div className="text-xs">
                      <span
                        className={
                          editComment.length > 140
                            ? 'font-bold text-red-600'
                            : editComment.length >= 120
                            ? 'font-bold text-yellow-600'
                            : 'text-gray-500'
                        }
                      >
                        {editComment.length} / 140文字
                      </span>
                      {editComment.length >= 120 && editComment.length <= 140 && (
                        <span className="block text-yellow-600 sm:ml-2 sm:inline">
                          ⚠️ 文章が途切れる可能性があります
                        </span>
                      )}
                      {editComment.length > 140 && (
                        <span className="block text-red-600 sm:ml-2 sm:inline">
                          ❌ 140文字以内にしてください
                        </span>
                      )}
                    </div>
                    <div className="flex gap-2 self-end sm:self-auto">
                      <button onClick={handleCancelEdit} className="rounded px-3 py-1 text-xs font-semibold text-gray-600 hover:bg-gray-200">
                        キャンセル
                      </button>
                      <button onClick={() => handleSaveEdit(record.id)} disabled={editComment.length > 140} className="rounded bg-orange-500 px-3 py-1 text-xs font-semibold text-white hover:bg-orange-600 disabled:opacity-50">
                        保存
                      </button>
                    </div>
                  </div>
                </div>
              ) : (
                record.comment && <p className="mb-3 whitespace-pre-wrap text-gray-700">{record.comment}</p>
              )}

              {record.minutes > 0 && (
                <div className="flex items-center gap-2 rounded-lg bg-orange-50 px-3 py-2 text-sm text-orange-700 mb-3">
                  <span>⏱️</span>
                  <span>{record.minutes}分</span>
                </div>
              )}

              {/* AIコメント */}
              <div className="rounded-lg bg-gradient-to-r from-blue-50 to-purple-50 border border-blue-100 px-4 py-3 mb-4">
                <div className="flex items-start gap-2">
                  <span className="text-lg flex-shrink-0">🤖</span>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-semibold text-blue-600 mb-1">えがけん応援コメント</p>
                    {record.aiComment ? (
                      <p className="text-sm text-gray-700 leading-relaxed whitespace-pre-wrap break-words">
                        {record.aiComment}
                      </p>
                    ) : (
                      <p className="text-sm text-gray-500 italic">コメント生成中...</p>
                    )}
                  </div>
                </div>
              </div>

              {/* アクションボタン */}
              <div className="flex flex-wrap items-center gap-2">
                <ShareButton 
                  recordId={record.id}
                  comment={record.comment}
                  practiceMinutes={record.minutes}
                  aiComment={record.aiComment}
                  imageUrl={record.imageUrl}
                  themeTitle={record.weeklyThemeTitle}
                />
                {editingId !== record.id && (
                  <button
                    onClick={() => handleEditClick(record)}
                    className="rounded-lg px-3 py-2 text-xs font-semibold text-gray-600 hover:bg-gray-50 transition"
                  >
                    編集
                  </button>
                )}
                <button
                  onClick={() => handleDelete(record.id)}
                  disabled={deletingId === record.id}
                  className="rounded-lg px-3 py-2 text-xs font-semibold text-red-600 hover:bg-red-50 disabled:opacity-50 transition"
                >
                  {deletingId === record.id ? '削除中...' : '削除'}
                </button>
              </div>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}
