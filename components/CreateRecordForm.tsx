'use client';

import { useRef, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { db, storage } from '@/lib/firebase';
import { collection, addDoc, serverTimestamp, updateDoc, doc } from 'firebase/firestore';
import { ref, uploadBytes, getDownloadURL } from 'firebase/storage';

interface CreateRecordFormProps {
  onSuccess?: () => void;
}

export function CreateRecordForm({ onSuccess }: CreateRecordFormProps) {
  const { user } = useAuth();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [comment, setComment] = useState('');
  const [practiceMinutes, setPracticeMinutes] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setSelectedFile(file);
      
      // プレビュー画像の生成
      const reader = new FileReader();
      reader.onload = (event) => {
        setPreview(event.target?.result as string);
      };
      reader.readAsDataURL(file);
      setError(null);
    }
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
      // Firebase Storageに画像をアップロード
      const fileName = `${user.uid}/${Date.now()}_${selectedFile.name}`;
      const storageRef = ref(storage, `records/${fileName}`);
      const uploadResult = await uploadBytes(storageRef, selectedFile);
      const imageUrl = await getDownloadURL(uploadResult.ref);

      // Firestoreにレコードを保存
      const recordRef = await addDoc(collection(db, 'records'), {
        userId: user.uid,
        imageUrl,
        comment: comment.trim() || '',
        practiceMinutes: practiceMinutes ? parseInt(practiceMinutes, 10) : 0,
        createdAt: serverTimestamp(),
        aiComment: '', // 初期値として空文字列を設定
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
          await updateDoc(doc(db, 'records', recordRef.id), {
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
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }

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
        
        {preview ? (
          <div className="mb-4 flex flex-col gap-4">
            <img
              src={preview}
              alt="削除"
              className="max-h-80 w-full rounded-lg object-contain border border-gray-200"
            />
            <button
              type="button"
              onClick={() => {
                setSelectedFile(null);
                setPreview(null);
                if (fileInputRef.current) {
                  fileInputRef.current.value = '';
                }
              }}
              className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50"
            >
              別の画像を選択
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="w-full rounded-lg border-2 border-dashed border-gray-300 p-8 text-center transition hover:border-orange-400 hover:bg-orange-50"
          >
            <div className="text-4xl mb-2">🖼️</div>
            <p className="font-semibold text-gray-700">クリックして画像を選択</p>
            <p className="text-xs text-gray-500">PNG, JPG, GIF</p>
          </button>
        )}
        
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          onChange={handleFileChange}
          className="hidden"
          disabled={isLoading}
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
          className="w-full rounded-lg border border-gray-300 px-4 py-3 text-sm placeholder-gray-400 focus:border-orange-400 focus:outline-none focus:ring-1 focus:ring-orange-400 disabled:bg-gray-50"
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
          className="w-full rounded-lg border border-gray-300 px-4 py-3 text-sm placeholder-gray-400 focus:border-orange-400 focus:outline-none focus:ring-1 focus:ring-orange-400 disabled:bg-gray-50"
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
