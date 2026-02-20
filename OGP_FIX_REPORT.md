# OGP画像・SNSキャッシュ問題 解決レポート

## 問題概要

- SNS（X/Twitter等）でシェアした際、OGP画像が「白画像」や「表示されない」状態になる。
- ページURLに `?v=...` を付与しても画像が更新されない、またはルーティングエラーになる。

## 原因分析

| アクセスURL | 挙動 | 技術的理由 |
| --- | --- | --- |
| `.../share/ID?v=...` | ページは開くが画像が白い | 画像URL内の `?` が重複し、Firebase Storageのトークンが壊れる |
| `.../share/ID&v=...` | 「投稿なし」ページになる | Next.jsがIDを誤認し、Firestoreに該当IDがない |

- Firebase Storage画像URLにキャッシュバスター（v）を付与すると、URL構文エラーで画像が表示されなくなる。
- SNSクローラーによっては、URLの `&` 以降を切り捨てたり、トークンを壊す場合がある。

## 解決策

1. **画像URLは一切加工しない**
    - OGP画像URL（og:image）は純粋なFirebase Storage URLをそのまま返す。
    - キャッシュバスター（v）はページURL（og:url, canonical）にのみ付与。
2. **Next.js/TypeScriptの型安全なProps設計**
    - `SharePostClient.tsx` の Propsに `v?: string` を追加。
    - サーバー側からクライアント側へ `v` を渡し、URL生成と同期。
3. **Firebase Storageアップロード時のcontentType指定**
    - `uploadBytes(storageRef, selectedFile, { contentType: selectedFile.type })` で画像のMIMEタイプを明示。
    - SNSクローラーが画像を正しく認識できるように。
4. **Next.js Imageタグのunoptimized追加**
    - `<Image ... unoptimized />` で画像最適化をバイパスし、Firebase Storage画像の互換性を向上。

## 実施した主な修正

- `page.tsx` の generateMetadata で画像URL加工を廃止、ページURLにのみvを付与。
- `SharePostClient.tsx` のProps型定義にvを追加し、型エラーを解消。
- `CreateRecordForm.tsx` のuploadBytesにcontentTypeを追加。
- `SharePostClient.tsx` のImageタグにunoptimizedを追加。
- app/share/[recordId]/SharePostClient.tsx の重複ファイルを削除し、components側に統一。

## 結果

- OGP画像がSNSで正しく表示されるようになった。
- キャッシュバスターによる画像更新も正常に動作。
- 型エラーやルーティングエラーも解消。

## 参考URL

- [https://egaken.vercel.app/share/JbNIsMqdZMoMQJmJCoNW?v=1771555483168](https://egaken.vercel.app/share/JbNIsMqdZMoMQJmJCoNW?v=1771555483168)

---

### 今後の教訓

- Firebase Storage画像URLは絶対に加工しない（トークン破壊防止）。
- OGPキャッシュバスターはページURLにのみ付与。
- contentType指定とunoptimizedでSNS互換性を担保。
- コンポーネント重複は型エラーの温床なので即整理。

## Google Cloud ShellによるCORS設定

- 以下のコマンドを実行し、Firebase StorageバケットのCORS設定を更新。

```sh
echo '[{"origin": ["*"],"method": ["GET"],"maxAgeSeconds": 3600}]' > cors.json
gcloud storage buckets update gs://egaken-b4a7e.firebasestorage.app --cors-file=cors.json
```

### 意義

- SNSクローラーや外部サービスがFirebase Storage画像にアクセスできるよう、CORS（クロスオリジンリソースシェア）を許可。
- OGP画像の表示やシェア時の互換性向上に直結。
- CORS設定が不十分だと、画像が正しく表示されない・アクセス拒否される問題が発生する。
