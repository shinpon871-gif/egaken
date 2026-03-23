'use client';

import { useRef, useState, useEffect } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { db, storage } from '@/lib/firebase';
import { collection, addDoc, serverTimestamp, updateDoc, doc } from 'firebase/firestore';
import { getCurrentWeeklyTheme } from '@/lib/getCurrentWeeklyTheme';
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
  const [characterType, setCharacterType] = useState('strategist'); // キャラ選択
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [currentTheme, setCurrentTheme] = useState<any>(null);
  const [participateInTheme, setParticipateInTheme] = useState(false); // お題参加チェックボックス
  const [showThemeInfoBanner, setShowThemeInfoBanner] = useState(false); // お題情報バナー初回表示フラグ

  useEffect(() => {
    (async () => {
      const theme = await getCurrentWeeklyTheme();
      setCurrentTheme(theme);

      // ローカルストレージから初回表示フラグを確認
      const hasSeenThemeInfo = localStorage.getItem('hasSeenThemeInfo');
      if (!hasSeenThemeInfo) {
        setShowThemeInfoBanner(true);
        localStorage.setItem('hasSeenThemeInfo', 'true');
      }
    })();
  }, []);

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

      // お題情報を取得
      const theme = await getCurrentWeeklyTheme();

      // Firestoreにレコードを投稿として保存
      const recordRef = await addDoc(collection(db, 'posts'), {
        userId: user.uid,
        imageUrl,
        minutes: practiceMinutes ? parseInt(practiceMinutes, 10) : 0,
        comment: comment.trim() || '',
        createdAt: serverTimestamp(),
        characterType: characterType || 'strategist',
        weeklyThemeId: currentTheme && participateInTheme
          ? currentTheme.id
          : null,
        weeklyThemeTitle: currentTheme && participateInTheme
          ? currentTheme.title
          : null,
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
              characterType: characterType || 'strategist',
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
      setCharacterType('strategist');

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

      {/* コメント・工夫した点（統合） */}
      <div className="mb-6">
        <label htmlFor="comment" className="mb-2 block text-sm font-semibold text-gray-700">
          コメント・今日の工夫した点（任意）
        </label>
        <textarea
          id="comment"
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          placeholder="何を描きましたか？工夫した点や挑戦したことも自由に書いてください。"
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



      {/* キャラクタータイプ選択 */}
      <div className="mb-6">
        <label htmlFor="characterType" className="mb-2 block text-sm font-semibold text-gray-700">
          コメントのキャラクタータイプ
        </label>
        <select
          id="characterType"
          value={characterType}
          onChange={(e) => setCharacterType(e.target.value)}
          disabled={isLoading}
          className="w-full rounded-lg border border-gray-300 px-4 py-3 text-sm text-gray-900 focus:border-orange-400 focus:outline-none focus:ring-1 focus:ring-orange-400 disabled:bg-gray-50"
        >
          <option value="strategist">知的で優しい参謀タイプ</option>
          <option value="genki">元気スポーツ少女</option>
          <option value="cool">クール無口</option>
          <option value="oneesan">お姉さん系</option>
          <option value="chuunibyou">中二病系</option>
          <option value="mascot">赤ちゃん言葉</option>
          <option value="sensei">先生タイプ</option>
        </select>
      </div>

      {/* 今週のお題表示 */}
      {currentTheme && (
        <>
          <div className="bg-blue-50 border border-blue-200 rounded p-3 mb-4">
            <p className="text-sm text-blue-800 font-semibold">
              今週のお題：{currentTheme.title}
            </p>
          </div>
          <label className="flex items-center space-x-2 mt-2">
            <input
              type="checkbox"
              checked={participateInTheme}
              onChange={(e) => setParticipateInTheme(e.target.checked)}
            />
            <span className="text-sm text-gray-700">
              参加する
            </span>
          </label>
          <p className="text-xs text-gray-500">
            お題バッジはシェア用プレビューにのみ付与され、作品そのものは加工されません。
          </p>
        </>
      )}
      {/* 送信ボタン */}
      <button
        type="submit"
        disabled={isLoading || !selectedFile}
        className="w-full rounded-lg bg-orange-500 px-6 py-3 font-semibold text-white transition hover:bg-orange-600 disabled:opacity-50 disabled:cursor-not-allowed mt-6"
      >
        {isLoading ? '保存中...' : '記録する'}
      </button>

      {/* 初回表示：お題情報バナー */}
      {showThemeInfoBanner && (
        <div className="bg-amber-50 border border-amber-200 rounded px-3 py-2 mt-4 h-8 flex items-center">
          <p className="text-xs text-amber-800">
            毎週の「お題」に参加して、みんなと一緒に作品を楽しみましょう（参加は任意）
          </p>
        </div>
      )}
    </form>
  );
}
