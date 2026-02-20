# 🤖 AIコメント機能ガイド

## 概要

「えがけん」にOpenAI APIを使ったAIコメント自動生成機能を追加。

## 仕様

- 投稿保存後、非同期でAIコメント生成APIを呼び出し、Firestoreに保存
- 失敗時は定型文を返却
- OGP/SNS・画像・contentType・unoptimized・CORS対応済み

## 実装例

- `/api/generate-comment/route.ts` でOpenAI API呼び出し
- Firestoreの該当レコードにaiCommentを保存

## 注意点

- 画像URLはそのまま、ページURLにのみ?v=...を付与
- contentType指定・unoptimized必須
- CORS設定必須

---

詳細は [OGP_FIX_REPORT.md](./OGP_FIX_REPORT.md) も参照。
