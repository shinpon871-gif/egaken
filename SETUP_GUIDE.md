# 🎨 えがけん - MVP セットアップガイド

お絵描きの記録を毎日続けるシンプルなWebアプリ「えがけん」のセットアップと動作確認手順です。

## 📁 フォルダ構成

```
egaken/
├── app/                                # Next.js App Router
│   ├── (auth)/
│   │   └── login/
│   │       └── page.tsx               # ログインページ
│   ├── (dashboard)/
│   │   ├── home/
│   │   │   └── page.tsx               # ホーム画面（記録一覧・投稿）
│   │   └── layout.tsx                 # ダッシュボードレイアウト
│   ├── globals.css                    # グローバルスタイル
│   ├── layout.tsx                     # ルートレイアウト（AuthProvider）
│   └── page.tsx                       # トップページ（リダイレクト）
├── components/
│   ├── CreateRecordForm.tsx           # 記録投稿フォーム
│   └── RecordList.tsx                 # 記録一覧
├── contexts/
│   └── AuthContext.tsx                # 認証コンテキスト
├── hooks/                             # カスタムフック（拡張用）
├── lib/
│   ├── firebase.ts                    # Firebase初期化
│   └── utils.ts                       # ユーティリティ関数
├── public/                            # 静的ファイル
├── .env.local.example                 # 環境変数テンプレート
├── package.json
├── tsconfig.json
├── tailwind.config.ts
└── README.md
```

## 🚀 セットアップ手順

### 1. Firebase プロジェクト作成

1. [Firebase Console](https://console.firebase.google.com) にアクセス
2. 新しいプロジェクトを作成
3. **Authentication** を設定
   - 「Sign-in method」から **Google** を有効化
4. **Firestore Database** を作成
   - ロケーション：東京（asia-northeast1）推奨
5. **Cloud Storage** を作成
6. プロジェクト設定から以下の値をコピー：
   - API Key (`apiKey`)
   - Auth Domain (`authDomain`)
   - Project ID (`projectId`)
   - Storage Bucket (`storageBucket`)
   - Messaging Sender ID (`messagingSenderId`)
   - App ID (`appId`)

### 2. 環境変数設定

`.env.local` ファイルを作成（`.env.local.example` から）：

```bash
cp .env.local.example .env.local
```

取得した値を `.env.local` に入力：

```
NEXT_PUBLIC_FIREBASE_API_KEY=xxxxxxxx
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=xxxxxxxx.firebaseapp.com
NEXT_PUBLIC_FIREBASE_PROJECT_ID=xxxxxxxx
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=xxxxxxxx.appspot.com
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=xxxxxxxx
NEXT_PUBLIC_FIREBASE_APP_ID=xxxxxxxx
```

### 3. 依存パッケージをインストール

```bash
npm install
```

### 4. Firebase セキュリティルール設定

#### Firestore ルール

Firebase Console > Firestore Database > Rules タブで以下に変更：

```javascript
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // 認証済みユーザーのみアクセス可能
    match /records/{document=**} {
      allow read, create, delete: if request.auth != null && 
        (request.auth.uid == resource.data.userId || !exists(resource));
      allow list: if request.auth != null;
    }
  }
}
```

#### Cloud Storage ルール

Firebase Console > Storage > Rules タブで以下に変更：

```javascript
rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /records/{userId}/{filename} {
      allow read: if request.auth != null;
      allow create: if request.auth != null && request.auth.uid == userId && 
        request.resource.size < 10 * 1024 * 1024 &&
        request.resource.contentType.matches('image/.*');
      allow delete: if request.auth != null && request.auth.uid == userId;
    }
  }
}
```

## 🏃 開発開始

### ローカルサーバー起動

```bash
npm run dev
```

ブラウザで [http://localhost:3000](http://localhost:3000) にアクセス

### 操作フロー

1. **ログイン画面**
   - 「Googleでログイン」をクリック
   - Google アカウント選択

2. **ホーム画面**
   - ✏️ 「今日の記録」ボタンクリック
   - 画像を選択（必須）
   - コメント記入（任意）
   - 練習時間入力（任意）
   - 「記録を保存」をクリック

3. **記録一覧**
   - 投稿した記録が新しい順に表示
   - 削除ボタンで削除可能
   - 日時、画像、コメント、練習時間が表示

## 📋 データ構造（Firestore）

### Collection: `records`

```typescript
{
  id: string;                    // ドキュメントID（自動生成）
  userId: string;                // ログインユーザーのID
  imageUrl: string;              // Cloud Storage URL
  comment: string;               // ユーザーのコメント
  practiceMinutes: number;       // 練習時間（分）
  createdAt: Timestamp;          // 作成日時
}
```

## 🛠️ 主要な実装

### 認証管理（AuthContext）
- `react-firebase-hooks/auth` で認証状態を監視
- useAuth() カスタムフックで簡単にアクセス

### 画像アップロード
- Firebase Storage に、ユーザーID + タイムスタンプで一意なパスで保存
- ファイルサイズ制限: 10MB
- 対応形式: PNG, JPG, GIF

### リアルタイム更新
- Firestore の `onSnapshot()` で リアルタイムリスナー実装
- 投稿後、即座に一覧に反映

## 🧪 動作確認チェックリスト

- [ ] ログイン/ログアウト機能が動作
- [ ] Googleアカウントでログイン可能
- [ ] ホーム画面に「今日の記録」ボタンが表示
- [ ] 画像選択・プレビュー表示
- [ ] コメント入力・送信
- [ ] 練習時間入力・送信
- [ ] 記録がFirestoreに保存される
- [ ] 投稿後、一覧に即座に表示される
- [ ] 画像がCloud Storageに保存される
- [ ] 削除ボタンで記録削除可能
- [ ] リダイレクト（未ログイン→login，ログイン済み→home）

## 📱 スマホ対応

Tailwind CSS による レスポンシブデザイン実装済み
- モバイルファースト設計
- タッチフレンドリーなボタン

## 🔒 セキュリティ

- Google認証による安全なログイン
- Firestore ルールでユーザーデータを隔離
- Storage ルールでファイルサイズとタイプを制限

## 📝 今後の拡張例

MVPの完成後、以下の機能追加が可能です：

- **ストリーク表示**：連続記録日数の表示
- **統計機能**：月別の記録数、総練習時間
- **カレンダービュー**：日付ごとの記録確認
- **検索/フィルタ**：コメントで記録検索
- **プロフィール**：ユーザー情報編集
- **AI コメント**：ChatGPT による自動コメント生成
- **ダークモード**：ダークテーマ対応

## 🐛 トラブルシューティング

### ログイン画面が表示されない
- `.env.local` に Firebase 設定が正しく入っているか確認
- ブラウザキャッシュをクリア

### 画像がアップロードされない
- Cloud Storage ルールが正しいか確認
- ファイルサイズが 10MB 以下か確認
- ブラウザのコンソールでエラーを確認

### Firestore に記録が保存されない
- Firestore ルールが正しいか確認
- ユーザーが認証済みか確認
- ネットワーク接続を確認

## 📚 参考リンク

- [Next.js Documentation](https://nextjs.org/docs)
- [Firebase Documentation](https://firebase.google.com/docs)
- [Tailwind CSS](https://tailwindcss.com)
- [react-firebase-hooks](https://github.com/CSFrequency/react-firebase-hooks)

---

Happy drawing! 🎨
