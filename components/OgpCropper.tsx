'use client';

import { useState, useCallback } from 'react';
import Cropper from 'react-easy-crop';
import type { Area } from 'react-easy-crop';

interface OgpCropperProps {
  imageSrc: string;
  onCropComplete: (croppedAreaPixels: Area, naturalSize: { width: number; height: number }) => void;
  onClose?: () => void;
}

export function OgpCropper({ imageSrc, onCropComplete, onClose }: OgpCropperProps) {
  const [crop, setCrop] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [croppedAreaPixels, setCroppedAreaPixels] = useState<Area | null>(null);
  const [naturalSize, setNaturalSize] = useState<{ width: number; height: number }>({ width: 0, height: 0 });

  const handleCropComplete = useCallback(
    (_croppedArea: Area, croppedAreaPixels: Area) => {
      setCroppedAreaPixels(croppedAreaPixels);
    },
    []
  );

  const handleMediaLoaded = useCallback((mediaSize: { width: number; height: number }) => {
    setNaturalSize(mediaSize);
  }, []);

  const handleApply = () => {
    if (croppedAreaPixels) {
      onCropComplete(croppedAreaPixels, naturalSize);
      onClose?.();
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black bg-opacity-50">
      <div className="flex-1 flex flex-col bg-white m-4 rounded-lg shadow-lg">
        {/* ヘッダー */}
        <div className="border-b border-gray-200 p-4 flex items-center justify-between">
          <h3 className="text-lg font-semibold text-gray-800">
            OGP画像のトリミング範囲を指定
          </h3>
          <button
            onClick={onClose}
            className="p-1 hover:bg-gray-100 rounded transition"
            title="閉じる"
          >
            <span className="text-2xl">✕</span>
          </button>
        </div>

        {/* ガイド情報 */}
        <div className="bg-blue-50 border-b border-blue-200 px-4 py-2">
          <p className="text-xs text-blue-700">
            💡 ドラッグでトリミング範囲を指定します。Twitter シェア時のプレビュー画像は 16:9 比率（1.91:1）で表示されます。
          </p>
        </div>

        {/* Cropper コンテナ */}
        <div className="flex-1 relative overflow-hidden">
          <Cropper
            image={imageSrc}
            crop={crop}
            zoom={zoom}
            aspect={1.91 / 1}
            cropShape="rect"
            showGrid={true}
            onCropChange={setCrop}
            onCropComplete={handleCropComplete}
            onZoomChange={setZoom}
            onMediaLoaded={handleMediaLoaded}
            restrictPosition={true}
          />
        </div>

        {/* ズームスライダー */}
        <div className="border-t border-gray-200 bg-gray-50 p-4">
          <label className="block text-sm font-medium text-gray-700 mb-2">
            ズーム: {Math.round(zoom * 100)}%
          </label>
          <input
            type="range"
            value={zoom}
            min={1}
            max={3}
            step={0.1}
            onChange={(e) => setZoom(Number(e.target.value))}
            className="w-full"
          />
        </div>

        {/* ボタン */}
        <div className="border-t border-gray-200 bg-white p-4 flex gap-3 justify-end rounded-b-lg">
          <button
            onClick={onClose}
            className="px-4 py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50 transition font-medium"
          >
            キャンセル
          </button>
          <button
            onClick={handleApply}
            disabled={!croppedAreaPixels}
            className="px-4 py-2 bg-orange-500 text-white rounded-lg hover:bg-orange-600 transition font-medium disabled:opacity-50 disabled:cursor-not-allowed"
          >
            適用
          </button>
        </div>
      </div>
    </div>
  );
}
