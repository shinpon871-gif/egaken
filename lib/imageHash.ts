// 短縮URLハッシュマップ管理（メモリ上）

declare global {
  // eslint-disable-next-line no-var
  // var __imageMap: Map<string, string> | undefined と同義、型定義のため必要
  var __imageMap: Map<string, string> | undefined;
}

const imageMap: Map<string, string> = globalThis.__imageMap || (globalThis.__imageMap = new Map());

export function setImageHash(hash: string, url: string) {
  imageMap.set(hash, url);
}

export function getImageUrl(hash: string): string | undefined {
  return imageMap.get(hash);
}
