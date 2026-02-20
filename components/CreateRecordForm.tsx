'use client';

import { useRef, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { db, storage } from '@/lib/firebase';
import { collection, addDoc, serverTimestamp, updateDoc, doc } from 'firebase/firestore';
import { ref, uploadBytes, getDownloadURL } from 'firebase/storage';
import { ImageUploadArea } from './ImageUploadArea';

interface CreateRecordFormProps {
  onSuccess?: () => void;
}

export function CreateRecordForm({ onSuccess }: CreateRecordFormProps) {
  const { user } = useAuth();
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [comment, setComment] = useState('');
  const [practiceMinutes, setPracticeMinutes] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleFileSelect = (file: File) => {
    setSelectedFile(file);
    
    // プレビュー画像の生成
    const reader = new FileReader();
    reader.onload = (event) => {
      setPreview(event.target?.result as string);
    };
    reader.readAsDataURL(file);
    setError(null);
  };

  const handlePreviewClear = () => {
    setSelectedFile(null);
    setPreview(null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!selectedFile || !user) {
      setError('画像を選択してください');
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      // Firebase Storageに画像をアップロード（contentTypeを明示指定）
      const fileName = `${user.uid}/${Date.now()}_${selectedFile.name}`;
      const storageRef = ref(storage, `records/${fileName}`);
      const uploadResult = await uploadBytes(storageRef, selectedFile, { contentType: selectedFile.type });
      const imageUrl = await getDownloadURL(uploadResult.ref);

      // Firestoreにレコードを投稿として保存
      const recordRef = await addDoc(collection(db, 'posts'), {
        userId: user.uid,
        imageUrl,
        minutes: practiceMinutes ? parseInt(practiceMinutes, 10) : 0,
        comment: comment.trim() || '',
        createdAt: serverTimestamp(),
      });

      // AI コメント生成を別途実行（記録の保存を待たずに非同期で実行）
      (async () => {
        try {
          const response = await fetch('/api/generate-comment', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              comment: comment.trim() || null,
              practiceMinutes: practiceMinutes ? parseInt(practiceMinutes, 10) : null,
            }),
          });

          if (!response.ok) {
            console.error('AI コメント生成失敗:', response.statusText);
            return;
          }

          const data = await response.json();
          const aiComment = data.aiComment || '';

          // Firestoreのレコードを更新
          await updateDoc(doc(db, 'posts', recordRef.id), {
            aiComment,
          });
        } catch (error) {
          console.error('AI コメント生成エラー:', error);
          // ここでエラーを表示しない（ユーザー体験を損なわないため）
        }
      })();

      // フォームをリセット
      setSelectedFile(null);
      setPreview(null);
      setComment('');
      setPracticeMinutes('');

      onSuccess?.();
    } catch (error) {
      console.error('記録保存エラー:', error);
      setError('記録の保存に失敗しました。もう一度試してください。');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="rounded-lg bg-white p-6 shadow-md">
      <h2 className="mb-6 text-2xl font-bold text-gray-800">今日のお絵描きを記録</h2>

      {error && (
        <div className="mb-4 rounded-lg bg-red-50 p-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* 画像アップロード */}
      <div className="mb-6">
        <label className="mb-2 block text-sm font-semibold text-gray-700">
          画像を選択 <span className="text-red-500">*</span>
        </label>
        
        <ImageUploadArea
          onFileSelect={handleFileSelect}
          preview={preview}
          onPreviewClear={handlePreviewClear}
          isLoading={isLoading}
        />
      </div>

      {/* コメント */}
      <div className="mb-6">
        <label htmlFor="comment" className="mb-2 block text-sm font-semibold text-gray-700">
          コメント（任意）
        </label>
        <textarea
          id="comment"
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          placeholder="何を描きましたか？今日の工夫した点は？"
          maxLength={500}
          disabled={isLoading}
          className="w-full rounded-lg border border-gray-300 px-4 py-3 text-sm text-gray-900 placeholder-gray-400 focus:border-orange-400 focus:outline-none focus:ring-1 focus:ring-orange-400 disabled:bg-gray-50"
          rows={4}
        />
        <p className="mt-1 text-xs text-gray-500">{comment.length}/500</p>
      </div>

      {/* 練習時間 */}
      <div className="mb-6">
        <label htmlFor="minutes" className="mb-2 block text-sm font-semibold text-gray-700">
          練習時間（分・任意）
        </label>
        <input
          id="minutes"
          type="number"
          value={practiceMinutes}
          onChange={(e) => setPracticeMinutes(e.target.value)}
          placeholder="0"
          min="0"
          max="1440"
          disabled={isLoading}
          className="w-full rounded-lg border border-gray-300 px-4 py-3 text-sm text-gray-900 placeholder-gray-400 focus:border-orange-400 focus:outline-none focus:ring-1 focus:ring-orange-400 disabled:bg-gray-50"
        />
      </div>

      {/* 送信ボタン */}
      <button
        type="submit"
        disabled={isLoading || !selectedFile}
        className="w-full rounded-lg bg-orange-500 px-6 py-3 font-semibold text-white transition hover:bg-orange-600 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {isLoading ? '保存中...' : '記録を保存'}
      </button>
    </form>
  );
}
