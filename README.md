# 🎨 えがけん（MVP）

お絵描きの記録を毎日続けるシンプルなWebアプリ。

## 主な機能

- Googleログイン認証
- 画像＋コメント＋練習時間の記録投稿
- 記録の一覧表示（新しい順）
- 記録削除
- 投稿直後のリアルタイム反映
- OGP画像・SNSシェア完全対応（画像URLはそのまま、ページURLに?v=...付与）
- 画像アップロード時はcontentType指定、Imageタグはunoptimized
- CORS設定済み

## 技術スタック

| 概要 | 技術 |
|------|------|
| フロント | Next.js 15+ (App Router) + React 19 + TypeScript |
| スタイリング | Tailwind CSS 4 |
| バックエンド | Firebase |
| 認証 | Firebase Authentication (Google) |
| データベース | Firestore |
| ストレージ | Cloud Storage |
| UIフック | react-firebase-hooks |

## フォルダ構成

```Bash
egaken/
├── app/
│   ├── (auth)/login/
│   ├── (dashboard)/home/
│   ├── share/[recordId]/page.tsx
│   └── layout.tsx
├── components/
│   ├── CreateRecordForm.tsx
│   ├── SharePostClient.tsx
│   ├── ShareButton.tsx
│   └── ...
├── contexts/
│   └── AuthContext.tsx
├── lib/
│   ├── firebase.ts
│   └── utils.ts
├── public/
│   └── ogp.png
├── OGP_FIX_REPORT.md
├── ...
```

## クイックスタート

詳しくは [QUICKSTART.md](./QUICKSTART.md) を参照してください。

```bash
# 1. リポジトリをクローン
git clone <your-repo>
cd egaken

# 2. 環境変数を設定
cp .env.local.example .env.local
# .env.local に Firebase 設定を記入
```

ブラウザで [http://localhost:3000](http://localhost:3000) を開く

## 📚 ドキュメント

| ドキュメント | 内容 |
| ----------- | ------ |
| [QUICKSTART.md](./QUICKSTART.md) | 5分で始めるガイド |
| [SETUP_GUIDE.md](./SETUP_GUIDE.md) | 詳細セットアップ＆フォルダ構成 |
| [FIREBASE_SETUP.md](./FIREBASE_SETUP.md) | Firebase初期化＆セキュリティルール |

## 📋 データ構造

### Firestore Collection: `records`

```typescript
{
  id: string,                  // ドキュメントID
  userId: string,              // ログインユーザーのID
  imageUrl: string,            // Cloud Storage URL
  comment: string,             // ユーザーのコメント（任意）
  practiceMinutes: number,     // 練習時間（分、任意）
  createdAt: Timestamp,        // 作成日時
}
```

## ✅ 動作確認チェック

```Bash
[ ] Google ログイン
[ ] ホーム画面表示
[ ] 記録投稿（画像選択）
[ ] コメント・練習時間入力
[ ] Firestore への保存
[ ] Cloud Storage への画像保存
[ ] 記録一覧の表示
[ ] リアルタイム更新
[ ] 記録削除
[ ] ログアウト
```

## 🔒 セキュリティ

- Firebase Authentication で安全なログイン
- Firestore ルールでユーザーデータを隔離
- Cloud Storage ルールでファイルサイズ・形式を制限

📌 **本運用前に Firestore・Storage のセキュリティルール設定が必須です！**  
詳細は [FIREBASE_SETUP.md](./FIREBASE_SETUP.md) を参照。

## 🔧 開発コマンド

```bash
# 開発サーバー起動
npm run dev

# 本番ビルド
npm run build

# 本番サーバー起動
npm start

# ESLint実行
npm run lint
```

## 📱 ブラウザ対応

- Chrome / Edge / Firefox / Safari（最新版）
- モバイル（レスポンシブ対応）

## 🚀 今後の拡張機能（候補）

MVP 達成後に実装可能な機能：

- **ストリーク表示** - 連続記録日数
- **統計** - 月別投稿数、総練習時間
- **カレンダービュー** - 日付ごとの記録確認
- **検索機能** - コメントで記録検索
- **プロフィール** - ユーザー情報編集
- **AI コメント** - ChatGPT 統合
- **ダークモード** - ダークテーマ対応

## 🐛 トラブル・質問

1. コンソール（F12）でエラーメッセージを確認
2. [QUICKSTART.md](./QUICKSTART.md#-トラブルシューティング) のトラブルシューティングを確認
3. [Firebase ドキュメント](https://firebase.google.com/docs) を参照

## 📄 ライセンス

MIT License

## 👨‍💻 開発者向け情報

- Next.js App Router 使用（Pages Router ではない）
- React 19 の最新機能を活用
- TypeScript strict mode 有効
- ESLint で コード品質管理

---

**Happy drawing!**

[セットアップをはじめる →](./QUICKSTART.md)
