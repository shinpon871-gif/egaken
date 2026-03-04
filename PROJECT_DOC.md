# えがけん 開発・運用ドキュメント

## 目次

- [えがけん 開発・運用ドキュメント](#えがけん-開発運用ドキュメント)
  - [目次](#目次)
  - [クイックスタート](#クイックスタート)
    - [📋 準備物](#-準備物)
    - [⚡ 5分でスタート](#-5分でスタート)
      - [1. Firebase プロジェクト作成（2分）](#1-firebase-プロジェクト作成2分)
      - [2. Firebase サービス有効化（1分）](#2-firebase-サービス有効化1分)
        - [Storage の料金プラン表示が出るときの対処](#storage-の料金プラン表示が出るときの対処)
          - [Firebase Emulator を使った開発（推奨・無料）](#firebase-emulator-を使った開発推奨無料)
      - [3. CORS設定（Storage画像のSNS対応）](#3-cors設定storage画像のsns対応)
      - [4. .env.local 設定](#4-envlocal-設定)
      - [5. 依存パッケージインストール](#5-依存パッケージインストール)
      - [6. 開発サーバー起動](#6-開発サーバー起動)
      - [7. OGP/SNS画像対策](#7-ogpsns画像対策)
      - [8. Twitter(X)シェア・AIコメント](#8-twitterxシェアaiコメント)
  - [概要](#概要)
  - [主な機能](#主な機能)
  - [技術スタック](#技術スタック)
  - [ディレクトリ構成](#ディレクトリ構成)
  - [セットアップガイド](#セットアップガイド)
  - [Firebaseセットアップ](#firebaseセットアップ)
    - [画像アップロード時の注意](#画像アップロード時の注意)
    - [CORS設定（Google Cloud Shell例）](#cors設定google-cloud-shell例)
  - [OGP・SNS・画像表示の注意点](#ogpsns画像表示の注意点)
  - [Twitter(X)共有機能ガイド](#twitterx共有機能ガイド)
    - [UI要素](#ui要素)
    - [Twitter(X)共有機能：実装例](#twitterx共有機能実装例)
    - [Twitter(X)共有機能：注意点](#twitterx共有機能注意点)
  - [AIコメント機能ガイド](#aiコメント機能ガイド)
    - [AIコメント機能：実装例](#aiコメント機能実装例)
      - [キャラクタータイプ例](#キャラクタータイプ例)
      - [型定義例（Record型）](#型定義例record型)
      - [Firestore構造例](#firestore構造例)
      - [APIリクエスト例](#apiリクエスト例)
      - [APIレスポンス例](#apiレスポンス例)
      - [拡張・カスタマイズ方法](#拡張カスタマイズ方法)
    - [AIコメント機能：注意点](#aiコメント機能注意点)
  - [開発コマンド](#開発コマンド)
  - [セキュリティ](#セキュリティ)
  - [今後の拡張機能候補](#今後の拡張機能候補)
  - [トラブル質問](#トラブル質問)
  - [ライセンス](#ライセンス)

---

## クイックスタート

「えがけん」MVP を素早くセットアップして動作確認するための手順です。

### 📋 準備物

- Node.js 18 以上
- Google アカウント
- Firebase プロジェクト（無料）

### ⚡ 5分でスタート

#### 1. Firebase プロジェクト作成（2分）

```Bash
1. https://console.firebase.google.com にアクセス
2. 「プロジェクトを作成」
3. プロジェクト名: egaken
4. Google Analytics: オフでOK
5. 「プロジェクトを作成」をクリック
```

#### 2. Firebase サービス有効化（1分）

**Authentication:**

- ビルド > Authentication
- 「Start」 > Google > 有効化

**Firestore Database:**

- ビルド > Firestore Database
- 「データベースを作成」
- ロケーション: asia-northeast1（東京）
- テスト モード で開始

**Cloud Storage:**

- ビルド > Storage
- 「始める」

> 注意: 一部の環境では `Storage を使用するには、プロジェクトの料金プランをアップグレードしてください` のようなメッセージが出ることがあります。以下を参照して回避してください。

##### Storage の料金プラン表示が出るときの対処

- 原因の例:
  - Firebase Console ではなく GCP（Google Cloud Console）側でバケット作成を試みたため課金アカウントが必要になった。
  - 組織ポリシーやプロジェクト作成時の設定により、無料プラン（Spark）での Storage 作成が制限されている。

- 回避策（開発中・MVP 向け）:
  1. まず Firebase コンソールの `Build > Storage > Get started`（Firebase の「始める」フロー）から作成を試みる。通常は Spark（無料）でバケットが作成できます。
  2. それでも同じメッセージが出る場合は、ローカルで Firebase Emulator を使って開発を進める（本番デプロイ前は実際の Cloud Storage に切り替え）。
     - エミュレータを使う利点: 実際の課金を必要とせず Storage/Firestore/Auth をローカルで試せます。

###### Firebase Emulator を使った開発（推奨・無料）

① `firebase-tools` をインストール（グローバル推奨）:

```bash
# グローバルインストール（必要な場合）
npm install -g firebase-tools
```

② プロジェクトルートでエミュレータを初期化（まだ未実行なら）:

```bash
firebase init emulators
```

③ エミュレータを起動（Firestore, Storage, Auth のみ）:

```bash
firebase emulators:start --only firestore,storage,auth
```

1) 開発用に `lib/firebase.ts` の初期化を切り替える（条件でエミュレータに接続）か、端末で `FIREBASE_FIRESTORE_EMULATOR_HOST` 等の環境変数を設定して接続します。

- 回避策（本番準備が必要な場合）:
  - 本当にクラウド Storage を利用する場合は、プロジェクトに課金アカウント（Blaze）を紐づけます。Blaze は従量課金ですが、少量なら無料枠内での利用も可能です。課金を有効にする前に使用量とコストを確認してください。

---

#### 3. CORS設定（Storage画像のSNS対応）

```sh
echo '[{"origin": ["*"],"method": ["GET"],"maxAgeSeconds": 3600}]' > cors.json
gcloud storage buckets update gs://<your-bucket> --cors-file=cors.json
```

#### 4. .env.local 設定

Firebase Consoleから各種キーを取得し、.env.localに記入。

#### 5. 依存パッケージインストール

```bash
npm install
```

#### 6. 開発サーバー起動

```bash
npm run dev
```

#### 7. OGP/SNS画像対策

- 画像URLはそのまま。ページURLにのみ?v=...を付与。
- 画像アップロード時はcontentType指定、Imageタグはunoptimized。

#### 8. Twitter(X)シェア・AIコメント

- シェアボタンは常に最新の?v=...付きURLを生成。
- AIコメントはOpenAI APIで非同期生成、失敗時は定型文返却。

---

## 概要

お絵描きの記録を毎日続けるシンプルなWebアプリ「えがけん」の開発・運用ドキュメントです。

## 主な機能

- Googleログイン認証（Firebase Authentication）
- メールアドレス＋パスワードでのログイン・新規登録（/login）
- パスワードリセット（メール送信による再設定）
- 投稿（画像＋コメント＋練習時間）の作成・保存・削除（CreateRecordForm, RecordList, Firestore）
- 投稿の一覧表示・リアルタイム反映（RecordList, Firestore）
- 投稿詳細・シェアページ（/share/[recordId]）
- OGP画像自動生成（/api/og/[recordId]、SVGバッジ合成・透過PNG対応）
- SNSシェア（X(Twitter) intent連携、OGP/SNS画像・URL最適化）
- 画像アップロード時のcontentType指定・Next.js Imageタグunoptimized対応
- AIコメント自動生成（OpenAI API, /api/generate-comment、キャラクタータイプ選択・保存・表示）
- メールアドレス追加（Google連携ユーザー向け、LinkEmailForm）
- ユーザー名変更・プロフィール編集（UserProfileForm, /profile）
- 統計・成長グラフ表示（StatsDisplay, Growth, /dashboard/growth、初回投稿と最新投稿の比較）
- デバッグ用ストレージ診断（/dashboard/debug-storage、Storage画像URLの動作・CORS・セキュリティルール確認）
- Firebase Storageセキュリティ診断（FirebaseSecurityDiagnostic）
- CORS設定済み

## 技術スタック

| 概要 | 技術 |
| --- | --- |
| フロント | Next.js 15+ (App Router), React 19, TypeScript |
| スタイリング | Tailwind CSS 4 |
| バックエンド | Firebase (Firestore, Storage, Auth) |
| 認証 | Firebase Authentication (Google) |
| データベース | Firestore |
| ストレージ | Cloud Storage |
| API | Next.js API Routes (/api/generate-comment, /api/image-proxy) |
| AI | OpenAI API (AIコメント生成) |
| UIフック | react-firebase-hooks |
| その他 | ESLint, PostCSS, OGP対応, CORS, etc. |

## ディレクトリ構成

```Bash
egaken/
├── app/
│   ├── globals.css
│   ├── layout.tsx
│   ├── not-found.tsx
│   ├── page.tsx
│   ├── (auth)/
│   │   └── login/
│   │       └── page.tsx
│   ├── (dashboard)/
│   │   ├── layout.tsx
│   │   ├── debug-storage/
│   │   │   └── page.tsx
│   │   ├── growth/
│   │   │   └── page.tsx
│   │   ├── history/
│   │   │   └── page.tsx
│   │   ├── home/
│   │   │   └── page.tsx
│   │   ├── post/
│   │   │   └── [id]/
│   │   │       └── page.tsx
│   │   └── ...
│   ├── api/
│   │   ├── generate-comment/
│   │   │   └── route.ts
│   │   └── image-proxy/
│   │       └── route.ts
│   ├── auth/
│   │   └── login/
│   │       └── page.tsx
│   ├── i/
│   │   └── [hash]/
│   │       └── route.ts
│   ├── profile/
│   │   └── page.tsx
│   ├── record/
│   │   └── [recordId]/
│   │       └── page.tsx
│   ├── share/
│   │   └── [recordId]/
│   │       ├── metadata.ts
│   │       └── page.tsx
│   └── ...
├── components/
│   ├── CreateRecordForm.tsx
│   ├── FirebaseSecurityDiagnostic.tsx
│   ├── HistoryGrid.tsx
│   ├── ImageUploadArea.tsx
│   ├── LinkEmailForm.tsx
│   ├── RecordList.tsx
│   ├── ShareButton.tsx
│   ├── SharePostClient.tsx
│   ├── StatsDisplay.tsx
│   └── UserProfileForm.tsx
├── contexts/
│   └── AuthContext.tsx
├── lib/
│   ├── firebase.ts
│   ├── getPost.ts
│   ├── growth.ts
│   ├── stats.ts
│   ├── twitter.ts
│   └── utils.ts
├── public/
│   └── ogp.png
├── ...
```

## セットアップガイド

1. リポジトリをクローン
2. Firebase Consoleから各種キーを取得し、`.env.local` に設定（NEXT_PUBLIC_FIREBASE_... で始まる環境変数）
3. `npm install` で依存パッケージを導入
4. `npm run dev` で開発サーバー起動
5. ブラウザで <http://localhost:3000> にアクセス
6. Google認証・記録投稿・プロフィール編集・AIコメント・シェア等を動作確認

※詳細なトラブルシューティングやTipsはQUICKSTART.mdも参照。

## Firebaseセットアップ

```typescript
import { initializeApp, getApps, getApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";
import { getStorage } from "firebase/storage";

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};
const app = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
export const storage = getStorage(app);
```

### 画像アップロード時の注意

```typescript
await uploadBytes(storageRef, file, { contentType: file.type });
```

### CORS設定（Google Cloud Shell例）

```sh
echo '[{"origin": ["*"],"method": ["GET"],"maxAgeSeconds": 3600}]' > cors.json
gcloud storage buckets update gs://<your-bucket> --cors-file=cors.json
```

## OGP・SNS・画像表示の注意点

- OGP画像URLはFirebase Storageの生URLをそのまま使用し、v等のクエリは付与しない。
- ページURL（og:url, canonical）にのみキャッシュバスター（?v=...）を付与。
- 画像アップロード時は `uploadBytes(..., { contentType: file.type })` でMIMEタイプを必ず指定。
- Next.jsのImageタグには `unoptimized` を付与し、Storage画像の互換性を担保。
- CORS設定はGoogle Cloud Shellで明示的に許可。

## Twitter(X)共有機能ガイド

- シェアボタンは常に最新の?v=...付きURLを生成。
- OGP画像URLはそのまま、ページURLにのみ?v=...を付与。
- 画像アップロード時はcontentType指定、Imageタグはunoptimized。
- CORS設定済み。

### UI要素

- 「𝕏で共有」ボタンでXのintentダイアログが開く
- 投稿プレビュー・文字数カウンター・エラー表示

### Twitter(X)共有機能：実装例

```typescript
const timestamp = Date.now();
const baseUrl = window.location.origin;
const shareUrl = `${baseUrl}/share/${recordId}?v=${timestamp}`;
const xText = `練習の記録をシェアしました！\n${shareUrl}`;
const xIntentUrl = `https://twitter.com/intent/tweet?text=${encodeURIComponent(xText)}`;
```

### Twitter(X)共有機能：注意点

- 画像URLに?v=...を付与しない（トークン破壊防止）
- ページURLにのみキャッシュバスター
- contentType指定・unoptimized必須
- CORS設定必須

## AIコメント機能ガイド

- 投稿保存後、非同期でAIコメント生成APIを呼び出し、Firestoreに保存
- 失敗時は定型文を返却
- OGP/SNS・画像・contentType・unoptimized・CORS対応済み

### AIコメント機能：実装例

- `/api/generate-comment/route.ts` でOpenAI API呼び出し
- Firestoreの該当レコードに `aiComment` と `characterType` を保存
- `CreateRecordForm.tsx` でキャラクタータイプ選択UI・API呼び出し・保存を実装
- `RecordList.tsx` で `aiComment` と `characterType` を表示

#### キャラクタータイプ例

| 値           | 表示名           |
|--------------|------------------|
| strategist   | 知的で優しい参謀 |
| genki        | 元気スポーツ少女 |
| cool         | クール無口       |
| oneesan      | お姉さん系       |
| chuunibyou   | 中二病系         |
| mascot       | 赤ちゃん言葉     |

#### 型定義例（Record型）

```typescript
interface Record {
  id: string;
  userId: string;
  imageUrl: string;
  comment: string;
  minutes: number;
  aiComment?: string; // AI生成コメント
  createdAt: Timestamp | null;
  characterType?: string; // キャラクタータイプ
}
```

#### Firestore構造例

```typescript
{
  id: string,
  userId: string,
  imageUrl: string,
  comment: string,
  practiceMinutes: number,
  createdAt: Timestamp,
  aiComment?: string,      // AI生成コメント
  characterType?: string,  // キャラクタータイプ
}
```

#### APIリクエスト例

```json
POST /api/generate-comment
{
  "imageUrl": "...",
  "practiceMinutes": 30,
  "characterType": "genki"
}
```

#### APIレスポンス例

```json
{
  "aiComment": "すごい！今日もたくさん練習したね！..."
}
```

#### 拡張・カスタマイズ方法

- キャラクター追加は `/api/generate-comment/route.ts` の `CHARACTER_CONFIG` に追記し、型（CharacterType）も拡張
- UIのセレクトボックスに新キャラを追加
- 定型文・プロンプトも `CHARACTER_CONFIG` で一元管理

### AIコメント機能：注意点

- 画像URLはそのまま、ページURLにのみ?v=...を付与
- contentType指定・unoptimized必須
- CORS設定必須
  
```typescript
  practiceMinutes: number,     // 練習時間（分、任意）
  createdAt: Timestamp,        // 作成日時
```

## 開発コマンド

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

## セキュリティ

- Firebase Authentication で安全なログイン
- Firestore ルールでユーザーデータを隔離
- Cloud Storage ルールでファイルサイズ・形式を制限
- Firestore・Storage のセキュリティルール設定が必須

## 今後の拡張機能候補

- ストリーク表示（連続記録日数）
- 統計（月別投稿数、総練習時間）
- カレンダービュー（日付ごとの記録確認）
- 検索機能（コメントで記録検索）
- プロフィール（ユーザー情報編集）
- AI コメント（ChatGPT統合）
- ダークモード（ダークテーマ対応）

## トラブル質問

1. コンソール（F12）でエラーメッセージを確認
2. QUICKSTART.mdのトラブルシューティングを確認
3. Firebase ドキュメントを参照

## ライセンス

MIT License

---

Happy drawing! 🎨
