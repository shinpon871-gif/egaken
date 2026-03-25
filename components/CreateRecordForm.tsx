'use client';

import { useState, useEffect } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { db, storage } from '@/lib/firebase';
import { collection, addDoc, serverTimestamp, updateDoc, doc } from 'firebase/firestore';
import { getCurrentWeeklyTheme } from '@/lib/getCurrentWeeklyTheme';
import { calculateTrainingDays } from '@/lib/utils';
import { ref, uploadBytes, getDownloadURL } from 'firebase/storage';
import { ImageUploadArea } from './ImageUploadArea';
import { OgpCropper } from './OgpCropper';
import type { Area } from 'react-easy-crop';

interface CreateRecordFormProps {
  onSuccess?: () => void;
}

interface OgpCropData {
  x: number;
  y: number;
  width: number;
  height: number;
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
  const [currentTheme, setCurrentTheme] = useState<Record<string, unknown> | null>(null);
  const [participateInTheme, setParticipateInTheme] = useState(false); // お題参加チェックボックス
  const [showThemeInfoBanner, setShowThemeInfoBanner] = useState(false); // お題情報バナー初回表示フラグ
  const [trainingDays, setTrainingDays] = useState<number>(0); // 通算日数
  const [showOgp, setShowOgp] = useState(true); // OGP画像表示フラグ
  const [ogpCrop, setOgpCrop] = useState<OgpCropData | null>(null); // OGP画像トリミング情報
  const [showCropper, setShowCropper] = useState(false); // Cropperモーダル表示フラグ

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

  // 通算日数を計算
  useEffect(() => {
    if (user?.uid) {
      calculateTrainingDays(user.uid).then(setTrainingDays);
    }
  }, [user?.uid]);

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
        characterType: characterType || 'strategist',
        weeklyThemeId: currentTheme && participateInTheme
          ? currentTheme.id
          : null,
        weeklyThemeTitle: currentTheme && participateInTheme
          ? currentTheme.title
          : null,
        showOgp,
        ogpCrop: ogpCrop || null,
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
      setShowOgp(true);
      setOgpCrop(null);

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

      {/* OGP設定（画像選択後に表示） */}
      {preview && (
        <div className="mb-6 border border-orange-200 bg-orange-50 rounded-lg p-4">
          <h3 className="font-semibold text-gray-800 mb-3">🖼️ Twitter シェア画像設定</h3>
          
          {/* OGP表示チェックボックス */}
          <div className="mb-3">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={showOgp}
                onChange={(e) => setShowOgp(e.target.checked)}
                disabled={isLoading}
                className="w-4 h-4"
              />
              <span className="text-sm text-gray-700">Twitter で OGP画像を表示する</span>
            </label>
            <p className="text-xs text-gray-600 mt-1 ml-6">
              オフにするとテキストのみでシェアされます
            </p>
          </div>

          {/* トリミング範囲設定 */}
          {showOgp && (
            <div className="mt-3 pt-3 border-t border-orange-200">
              <p className="text-sm text-gray-700 mb-2">
                📍 表示範囲を指定（オプション）
              </p>
              <button
                type="button"
                onClick={() => setShowCropper(true)}
                disabled={isLoading}
                className="text-sm px-3 py-1 bg-white border border-orange-400 text-orange-600 rounded hover:bg-orange-50 transition disabled:opacity-50"
              >
                {ogpCrop ? '✓ トリミング済み - 変更する' : 'トリミング範囲を指定'}
              </button>
              {ogpCrop && (
                <button
                  type="button"
                  onClick={() => setOgpCrop(null)}
                  className="text-xs ml-2 text-gray-600 hover:text-red-600 underline transition"
                >
                  リセット
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {/* Cropper モーダル */}
      {showCropper && preview && (
        <OgpCropper
          imageSrc={preview}
          onCropComplete={(croppedAreaPixels) => {
            // react-easy-crop の croppedAreaPixels は既に元画像ベースのピクセル座標
            // スケーリング補正は不要。そのまま保存する。
            const crop: OgpCropData = {
              x: Math.round(croppedAreaPixels.x),
              y: Math.round(croppedAreaPixels.y),
              width: Math.round(croppedAreaPixels.width),
              height: Math.round(croppedAreaPixels.height),
            };
            
            console.log('[CreateRecordForm] croppedAreaPixels をそのまま保存:', crop);
            
            setOgpCrop(crop);
          }}
          onClose={() => setShowCropper(false)}
        />
      )}

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

      {/* 通算日数表示 */}
      {trainingDays > 0 && (
        <div className="mb-6 p-3 bg-purple-50 rounded-lg border border-purple-100">
          <p className="text-sm text-purple-800">
            📅 <span className="font-semibold">通算 {trainingDays}日目</span> で投稿しようとしています
          </p>
        </div>
      )}



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
              今週のお題：{(currentTheme as Record<string, unknown>)?.title as string}
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
