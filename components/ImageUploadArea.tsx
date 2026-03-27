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

  // ファイル検証
  const validateFile = (file: File): boolean => {
    const validTypes = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
    
    if (!validTypes.includes(file.type)) {
      setError('画像ファイルのみアップロードできます（PNG、JPG、GIF、WebP）');
      return false;
    }

    const maxSize = 5 * 1024 * 1024; // 5MB
    if (file.size > maxSize) {
      setError('ファイルサイズは5MB以下にしてください');
      return false;
    }

    setError(null);
    return true;
  };

  // ファイル処理の共通処理
  const handleFile = (file: File) => {
    if (validateFile(file)) {
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

      {preview ? (
        <div className="mb-4 flex flex-col gap-4">
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
