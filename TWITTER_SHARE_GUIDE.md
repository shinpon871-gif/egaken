# 🐦 Twitter(X)共有機能ガイド

## 概要

「えがけん」に記録をX(Twitter)で共有できる機能の設計・実装・テストガイド。

## 仕様

- シェアボタンは常に最新の?v=...付きURLを生成。
- OGP画像URLはそのまま、ページURLにのみ?v=...を付与。
- 画像アップロード時はcontentType指定、Imageタグはunoptimized。
- CORS設定済み。

## UI要素

- 「𝕏で共有」ボタンでXのintentダイアログが開く
- 投稿プレビュー・文字数カウンター・エラー表示

## 実装例

```typescript
const timestamp = Date.now();
const baseUrl = window.location.origin;
const shareUrl = `${baseUrl}/share/${recordId}?v=${timestamp}`;
const xText = `練習の記録をシェアしました！\n${shareUrl}`;
const xIntentUrl = `https://twitter.com/intent/tweet?text=${encodeURIComponent(xText)}`;
```

## 注意点

- 画像URLに?v=...を付与しない（トークン破壊防止）
- ページURLにのみキャッシュバスター
- contentType指定・unoptimized必須
- CORS設定必須

---

詳細は [OGP_FIX_REPORT.md](./OGP_FIX_REPORT.md) も参照。
