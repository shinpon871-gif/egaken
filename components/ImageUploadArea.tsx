'use client';

import { useRef, useState } from 'react';

interface ImageUploadAreaProps {
  onFileSelect: (file: File) => void;
  preview: string | null;
  onPreviewClear: () => void;
  isLoading?: boolean;
}

export function ImageUploadArea({
  onFileSelect,
  preview,
  onPreviewClear,
  isLoading = false,
}: ImageUploadAreaProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dropZoneRef = useRef<HTMLDivElement>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isCompressing, setIsCompressing] = useState(false); // 圧縮中フラグ

  // 画像圧縮関数
  const compressImage = async (file: File): Promise<File | null> => {
    return new Promise((resolve) => {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      const img = new Image();
      
      img.onload = () => {
        // サイズを計算（最大幅/高さを800pxに制限）
        const maxDimension = 800;
        let { width, height } = img;
        if (width > height) {
          if (width > maxDimension) {
            height = (height * maxDimension) / width;
            width = maxDimension;
          }
        } else {
          if (height > maxDimension) {
            width = (width * maxDimension) / height;
            height = maxDimension;
          }
        }
        
        canvas.width = width;
        canvas.height = height;
        
        // 描画
        ctx?.drawImage(img, 0, 0, width, height);
        
        // JPEGで圧縮（品質0.8）
        canvas.toBlob((blob) => {
          if (blob && blob.size <= 5 * 1024 * 1024) {
            const compressedFile = new File([blob], file.name, { type: 'image/jpeg' });
            resolve(compressedFile);
          } else {
            resolve(null); // 圧縮失敗
          }
        }, 'image/jpeg', 0.8);
      };
      
      img.src = URL.createObjectURL(file);
    });
  };

  // ファイル検証（圧縮対応）
  const validateFile = async (file: File): Promise<boolean> => {
    const validTypes = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
    
    if (!validTypes.includes(file.type)) {
      setError('画像ファイルのみアップロードできます（PNG、JPG、GIF、WebP）');
      return false;
    }

    const maxSize = 5 * 1024 * 1024; // 5MB
    if (file.size > maxSize) {
      setIsCompressing(true);
      const compressedFile = await compressImage(file);
      setIsCompressing(false);
      
      if (compressedFile) {
        // 圧縮成功：圧縮ファイルを親コンポーネントに渡す
        onFileSelect(compressedFile);
        setError(null);
        return true;
      } else {
        setError('ファイルサイズが大きすぎます。圧縮しても5MBを超えます。');
        return false;
      }
    }

    setError(null);
    return true;
  };

  // ファイル処理の共通処理
  const handleFile = async (file: File) => {
    if (await validateFile(file)) {
      onFileSelect(file);
    }
  };

  // ファイル入力の変更イベント
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      handleFile(file);
    }
  };

  // ドラッグオーバーイベント
  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(true);
  };

  // ドラッグリーブイベント
  const handleDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
  };

  // ドロップイベント
  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);

    const file = e.dataTransfer.files?.[0];
    if (file) {
      handleFile(file);
    }
  };

  // ペーストイベント
  const handlePaste = (e: React.ClipboardEvent<HTMLDivElement>) => {
    const file = e.clipboardData.files?.[0];
    if (file) {
      handleFile(file);
    }
  };

  return (
    <div>
      {error && (
        <div className="mb-4 rounded-lg bg-red-50 p-3 text-sm text-red-700">
          {error}
        </div>
      )}
      
      {isCompressing && (
        <div className="mb-4 rounded-lg bg-blue-50 p-3 text-sm text-blue-700">
          画像を圧縮中...
        </div>
      )}

      {preview ? (
        <div className="mb-4 flex flex-col gap-4">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={preview}
            alt="プレビュー"
            className="max-h-80 w-full rounded-lg object-contain border border-gray-200"
          />
          <button
            type="button"
            onClick={onPreviewClear}
            disabled={isLoading}
            className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            別の画像を選択
          </button>
        </div>
      ) : (
        <div
          ref={dropZoneRef}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          onPaste={handlePaste}
          onClick={() => fileInputRef.current?.click()}
          className={`relative w-full rounded-lg border-2 border-dashed p-8 text-center transition cursor-pointer ${
            isDragOver
              ? 'border-orange-400 bg-orange-50'
              : 'border-gray-300 hover:border-orange-400 hover:bg-orange-50'
          } ${isLoading ? 'opacity-50 cursor-not-allowed' : ''}`}
        >
          <div className="text-4xl mb-2">🖼️</div>
          <p className="font-semibold text-gray-700">
            {isDragOver ? 'ここにドロップ' : 'クリック・ドラッグ・貼り付けで画像追加'}
          </p>
          <p className="text-xs text-gray-500 mt-1">PNG, JPG, GIF, WebP（最大5MB）</p>
        </div>
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
  );
}
