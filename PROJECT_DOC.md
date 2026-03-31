# えがけん 開発・運用ドキュメント

## 目次

- [えがけん 開発・運用ドキュメント](#えがけん-開発運用ドキュメント)
  - [目次](#目次)
  - [概要](#概要)
  - [現在の実装サマリ](#現在の実装サマリ)
  - [技術スタック](#技術スタック)
  - [クイックスタート](#クイックスタート)
    - [準備物](#準備物)
    - [セットアップ手順](#セットアップ手順)
  - [環境変数](#環境変数)
  - [Firebaseセットアップ](#firebaseセットアップ)
    - [Authentication](#authentication)
    - [Firestore](#firestore)
    - [Storage](#storage)
    - [CORS設定](#cors設定)
  - [データ構造](#データ構造)
    - [posts コレクション](#posts-コレクション)
    - [weeklyThemes コレクション](#weeklythemes-コレクション)
    - [nineShares コレクション](#nineshares-コレクション)
    - [users コレクション](#users-コレクション)
  - [主要画面](#主要画面)
    - [`/`](#)
    - [`/login`](#login)
    - [`/home`](#home)
    - [`/history`](#history)
    - [`/growth`](#growth)
    - [`/profile`](#profile)
    - [`/record/[recordId]`](#recordrecordid)
    - [`/share/[recordId]`](#sharerecordid)
    - [`/nine/[shareId]`](#nineshareid)
    - [`/debug-storage`](#debug-storage)
    - [`/debug-theme`](#debug-theme)
  - [主要API](#主要api)
    - [`POST /api/generate-comment`](#post-apigenerate-comment)
    - [`GET /api/myPosts?uid={uid}`](#get-apimypostsuiduid)
    - [`POST /api/createNine`](#post-apicreatenine)
    - [`GET /api/og/[recordId]`](#get-apiogrecordid)
    - [`GET /api/grid/[shareId]`](#get-apigridshareid)
    - [`GET /api/nine-ogp/[shareId]`](#get-apinine-ogpshareid)
    - [`GET /api/image-proxy?url=...`](#get-apiimage-proxyurl)
    - [`GET /api/debug-theme`](#get-apidebug-theme)
  - [OGP・SNS共有](#ogpsns共有)
  - [AIコメント機能](#aiコメント機能)
  - [週間お題機能](#週間お題機能)
  - [9選機能](#9選機能)
    - [概要](#概要-1)
    - [現在のフロー](#現在のフロー)
    - [生成画像仕様](#生成画像仕様)
    - [関連ファイル](#関連ファイル)
  - [ディレクトリ構成](#ディレクトリ構成)
  - [開発コマンド](#開発コマンド)
  - [セキュリティと運用上の注意](#セキュリティと運用上の注意)
  - [既知の注意点](#既知の注意点)
  - [トラブルシュート](#トラブルシュート)
    - [ログインできない](#ログインできない)
    - [画像アップロードに失敗する](#画像アップロードに失敗する)
    - [AI コメントが付かない](#ai-コメントが付かない)
    - [共有画像が意図通り出ない](#共有画像が意図通り出ない)
    - [9選生成に失敗する](#9選生成に失敗する)
    - [週間お題が出ない](#週間お題が出ない)
  - [ライセンス](#ライセンス)

---

## 概要

えがけんは、お絵描きの練習を日々記録し、あとから振り返り、SNSで共有できる Next.js ベースの Web アプリです。

現在の実装では、認証、画像付き投稿、投稿一覧、コメント編集・削除、AI応援コメント、週間お題、成長表示、X 共有、単一投稿 OGP、9選生成と共有まで一通り動作します。

---

## 現在の実装サマリ

- Firebase Authentication による Google ログイン
- メールアドレス + パスワードでの新規登録・ログイン
- パスワードリセットメール送信
- Google ログイン済みユーザーへのメールアドレス連携
- Firebase Storage への画像アップロード
- 投稿作成、一覧表示、コメント編集、投稿削除
- 練習時間、通算日数、継続日数、累計投稿数の可視化
- OpenAI を使った応援コメント生成
- 週間お題の取得と投稿への紐付け
- 投稿詳細ページと共有ページの表示
- OGP 画像の動的生成と X 共有
- 任意の 9 投稿から 9選画像を生成し共有
- Storage 動作確認用のデバッグ画面
- 週間お題確認用のデバッグ画面

---

## 技術スタック

| 区分 | 技術 |
| --- | --- |
| フロントエンド | Next.js 15.5, React 19, TypeScript |
| スタイリング | Tailwind CSS 4 |
| 認証 | Firebase Authentication |
| データベース | Cloud Firestore |
| ストレージ | Firebase Storage |
| サーバー処理 | Next.js App Router Route Handlers |
| 画像処理 | sharp, react-easy-crop |
| AI | OpenAI API |
| 開発補助 | ESLint 9, PostCSS |
| 動作前提 | Node.js 24.x |

---

## クイックスタート

### 準備物

- Node.js 24.x
- npm
- Firebase プロジェクト
- OpenAI API キー
- Firebase Admin SDK 用サービスアカウント

### セットアップ手順

1. 依存関係をインストール

```bash
npm install
```

2. ルートに `.env.local` を作成し、必要な環境変数を設定

3. ローカル開発では以下のいずれかで Admin SDK を有効化

- ルートにサービスアカウント JSON を置く
- `FIREBASE_SERVICE_ACCOUNT_KEY` に JSON 文字列を設定する

4. Firebase Console で Authentication / Firestore / Storage を有効化

5. Storage に CORS を設定

6. 開発サーバーを起動

```bash
npm run dev
```

7. ブラウザで `http://localhost:3000` を開く

---

## 環境変数

`.env.local` の例です。

```bash
NEXT_PUBLIC_FIREBASE_API_KEY=...
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=...
NEXT_PUBLIC_FIREBASE_PROJECT_ID=...
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=...
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=...
NEXT_PUBLIC_FIREBASE_APP_ID=...
OPENAI_API_KEY=...
FIREBASE_SERVICE_ACCOUNT_KEY='{"type":"service_account",...}'
```

用途は以下の通りです。

- `NEXT_PUBLIC_FIREBASE_*`: クライアント SDK 初期化用
- `OPENAI_API_KEY`: AI コメント生成 API 用
- `FIREBASE_SERVICE_ACCOUNT_KEY`: サーバー側 Admin SDK 初期化用

補足:

- ローカルでは `egaken-b4a7e-firebase-adminsdk-fbsvc-dacdaab784.json` を直接読むフォールバック実装があります。
- 本番では `FIREBASE_SERVICE_ACCOUNT_KEY` を設定する前提です。

---

## Firebaseセットアップ

### Authentication

有効化が必要な認証方式:

- Google
- メール / パスワード

実装済みの認証フロー:

- Google ポップアップログイン
- メールアドレス新規登録
- メールアドレスログイン
- パスワードリセットメール送信
- Google ログイン済みアカウントへのメールアドレス追加

アプリ内ブラウザ注意:

- Google ログインはアプリ内ブラウザを検出した場合、外部ブラウザ利用を促す UI を表示します。

### Firestore

主に使用するコレクション:

- `posts`
- `weeklyThemes`
- `nineShares`
- `users`

現行コードでは投稿データの主保存先は `posts` です。

### Storage

アップロード先パス:

```text
records/{userId}/{timestamp}_{uuid}.{ext}
```

フロント側の許可形式:

- PNG
- JPEG
- WebP
- GIF

フロント側のサイズ上限:

- 5MB

重要:

- Storage ルールの最大サイズ制限は、フロント側バリデーションと同じ 5MB に揃えてください。
- `uploadBytes(..., { contentType: file.type })` で MIME Type を明示しています。

推奨ルール例:

```text
rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /records/{userId}/{filename} {
      allow read: if request.auth != null;
      allow create: if request.auth != null
        && request.auth.uid == userId
        && request.resource.size < 5 * 1024 * 1024
        && request.resource.contentType.matches('image/(jpeg|png|webp|gif)');
      allow delete: if request.auth != null && request.auth.uid == userId;
    }

    match /nineShares/{filename} {
      allow read: if true;
      allow write: if false;
    }
  }
}
```

### CORS設定

Storage の画像を共有やプレビューで扱うため、CORS を設定します。

```sh
echo '[{"origin": ["*"],"method": ["GET"],"maxAgeSeconds": 3600}]' > cors.json
gcloud storage buckets update gs://<your-bucket> --cors-file=cors.json
```

---

## データ構造

### posts コレクション

投稿の主データです。

```typescript
{
  userId: string;
  imageUrl: string;
  minutes: number;
  comment: string;
  createdAt: Timestamp;
  updatedAt?: Timestamp;
  aiComment?: string;
  characterType?: string;
  weeklyThemeId?: string | null;
  weeklyThemeTitle?: string | null;
  showOgp?: boolean;
  ogpCrop?: {
    x: number;
    y: number;
    width: number;
    height: number;
  } | null;
}
```

### weeklyThemes コレクション

週間お題の管理用データです。

```typescript
{
  title: string;
  startAt: Timestamp;
  endAt: Timestamp;
}
```

### nineShares コレクション

9選画像の共有データです。

```typescript
{
  postIds: string[];
  imageUrls: string[];
  imageStoragePath: string;
  imageUrl: string;
  createdAt: string;
  updatedAt: string;
}
```

### users コレクション

プロフィール更新時に補助的に保存されます。

```typescript
{
  displayName?: string;
}
```

---

## 主要画面

### `/`

- 認証状態を見て `/home` または `/login` にリダイレクトします。

### `/login`

- Google ログイン
- メールアドレスログイン
- メールアドレス新規登録
- パスワードリセット

### `/home`

- 統計表示
- 新規投稿フォームの開閉
- 投稿一覧表示
- ヒストリー、成長、プロフィールへの導線

### `/history`

- 自分の投稿をグリッド表示
- 画像クリックで詳細へ遷移
- チェックボックスで最大 9 枚選択
- 9選生成を実行

### `/growth`

- 初回投稿と最新投稿を比較表示
- 継続日数を表示
- 投稿が 2 件未満なら説明メッセージを表示

### `/profile`

- ユーザー名更新
- メールアドレス追加
- 現在の認証プロバイダ表示

### `/record/[recordId]`

- 単一投稿の詳細表示
- 共有 UI 表示
- OGP メタデータ生成あり

### `/share/[recordId]`

- 外部共有向けページ
- `og=0` で OGP 画像なし共有に切り替え可能
- `v` パラメータでページ側のキャッシュバスターを付与

### `/nine/[shareId]`

- 9選画像の共有ページ
- X 投稿導線あり

### `/debug-storage`

- 最新投稿の Storage URL を検査
- `/api/image-proxy` 経由での取得確認

### `/debug-theme`

- `weeklyThemes` の時刻比較を可視化

---

## 主要API

### `POST /api/generate-comment`

役割:

- OpenAI を使って応援コメントを生成

入力:

```json
{
  "comment": "線の強弱を意識した",
  "practiceMinutes": 30,
  "characterType": "strategist"
}
```

出力:

```json
{
  "aiComment": "線の強弱を意識した点がとても良いですね。..."
}
```

### `GET /api/myPosts?uid={uid}`

役割:

- 指定ユーザーの投稿一覧を取得
- 9選用のグリッド表示に使う

返却項目:

- `id`
- `imageUrl`
- `isTopNine`
- `weeklyThemeTitle`
- `isMissingUserId`

### `POST /api/createNine`

役割:

- 9 枚の投稿画像を 3x3 の JPEG に合成
- Storage に保存
- `nineShares` に共有データを保存

入力条件:

- `postIds` は必ず 9 件

### `GET /api/og/[recordId]`

役割:

- 単一投稿用の OGP 画像を生成
- `ogpCrop` があればトリミングを反映

### `GET /api/grid/[shareId]`

役割:

- 9選用の OGP 画像を `next/og` で生成

### `GET /api/nine-ogp/[shareId]`

役割:

- 9選画像を生成・保存・公開 URL を返す補助 API
- `nineShares` の `imageUrls` フィールドから画像を取得して合成する
- 現行の主経路 (`/api/createNine`) ではなく補助実装として存在する

### `GET /api/image-proxy?url=...`

役割:

- Storage 画像をサーバー側で取り直して返す
- デバッグ画面や CORS 回避確認に利用

### `GET /api/debug-theme`

役割:

- `weeklyThemes` を取得し、サーバー時刻と合わせて返す

---

## OGP・SNS共有

現在の共有仕様:

- 投稿共有 URL は `/share/[recordId]?og=1&v=...`
- OGP 画像の有無は `og` パラメータで切替
- ページ URL にのみ `v` を付与してキャッシュバスターに利用
- 単一投稿 OGP は `/api/og/[recordId]`
- 9選共有ページは `/nine/[shareId]`

X 投稿文の基本構成:

- `#えがけん記録`
- 練習時間
- 通算日数
- ユーザーコメント
- `#えがけん`
- 共有 URL

文字数仕様:

- 現在の実装は 140 文字上限でチェックしています。

OGP 画像の注意点:

- 投稿作成時に `showOgp` をオフにすると、共有ページ側でサマリーカードに切り替え可能です。
- 投稿作成時に `ogpCrop` を設定すると、単一投稿 OGP のトリミングに反映されます。

---

## AIコメント機能

投稿保存後、AI コメント生成は非同期で実行されます。

流れ:

1. 投稿を `posts` に保存
2. `POST /api/generate-comment` を呼び出し
3. 結果の `aiComment` を同じ投稿ドキュメントに追記
4. 投稿一覧や共有画面はリアルタイム監視で追従

キャラクタータイプ:

- `strategist`
- `genki`
- `cool`
- `oneesan`
- `chuunibyou`
- `mascot`
- `sensei`

実装上の特徴:

- ユーザーのコメント内容に具体的に触れるプロンプト設計
- 失敗時はキャラごとのフォールバック文を返す
- 投稿保存自体は AI 失敗で巻き戻さない

---

## 週間お題機能

`weeklyThemes` コレクションから、現在時刻が `startAt <= now <= endAt` に入るお題を取得します。

投稿フォームでの挙動:

- 現在有効なお題があればタイトルを表示
- チェックボックスで参加可否を選択
- 参加時のみ投稿に `weeklyThemeId` と `weeklyThemeTitle` を保存
- シェア時はお題タイトルをコメント先頭に付与

補足:

- お題バッジは共有用プレビュー向けの扱いで、元画像そのものは加工しません。

---

## 9選機能

### 概要

履歴画面から投稿を 9 枚選び、3x3 グリッドの共有画像を生成します。

### 現在のフロー

1. `/history` で `/api/myPosts?uid=...` を呼び出す
2. `HistoryGrid` で投稿を表示
3. 画像本体クリックで `/record/[recordId]` へ遷移
4. チェックボックスクリックで 9選候補に追加
5. 9 枚そろうと `POST /api/createNine` を実行
6. `sharp` で 1200x630 の JPEG を生成
7. Storage の `nineShares/{shareId}.jpg` に保存
8. Firestore の `nineShares/{shareId}` に保存
9. `/nine/[shareId]` に遷移

### 生成画像仕様

- 形式: JPEG
- サイズ: 1200x630
- 配置: 3x3
- 画像取得失敗時はグレーの代替画像を使用

### 関連ファイル

- `components/HistoryGrid.tsx`
- `app/(dashboard)/history/page.tsx`
- `app/api/myPosts/route.ts`
- `app/api/createNine/route.ts`
- `app/nine/[shareId]/page.tsx`
- `app/api/grid/[shareId]/route.tsx`

---

## ディレクトリ構成

生成物や管理用ディレクトリ（`.git/`, `.next/`, `node_modules/`, `.vercel/`, `.DS_Store` など）は除き、実装・設定上意味のあるファイルを中心にまとめています。

```bash
egaken/
├── .env.local                                  # ローカル開発用の環境変数ファイル
├── .gitignore                                  # Git管理から除外するファイル定義
├── PROJECT_DOC.md                              # この開発・運用ドキュメント
├── egaken-b4a7e-firebase-adminsdk-fbsvc-dacdaab784.json  # ローカル用 Firebase Admin SDK 鍵
├── eslint.config.mjs                           # ESLint 設定
├── file.tmp                                    # 一時作業用ファイル
├── firestore.indexes.json                      # Firestore インデックス定義
├── next-env.d.ts                               # Next.js 用型定義
├── next.config.ts                              # Next.js 設定
├── package-lock.json                           # npm lock file
├── package.json                                # 依存関係と scripts
├── postcss.config.mjs                          # PostCSS 設定
├── tsconfig.json                               # TypeScript 設定
├── app/
│   ├── globals.css                             # グローバルスタイル
│   ├── layout.tsx                              # ルートレイアウトと全体メタデータ
│   ├── not-found.tsx                           # 404 ページ
│   ├── page.tsx                                # ルートリダイレクトページ
│   ├── (auth)/login/page.tsx                   # ログイン画面
│   ├── (dashboard)/layout.tsx                  # ログイン後共通レイアウト
│   ├── (dashboard)/debug-storage/page.tsx      # Storage デバッグ画面
│   ├── (dashboard)/debug-theme/page.tsx        # 週間お題デバッグ画面
│   ├── (dashboard)/growth/page.tsx             # 成長比較ページ
│   ├── (dashboard)/history/page.tsx            # 投稿履歴と 9選画面
│   ├── (dashboard)/home/page.tsx               # ホーム画面
│   ├── (dashboard)/post/[id]/page.tsx          # 自分用投稿詳細
│   ├── api/createNine/route.ts                 # 9選画像生成 API
│   ├── api/debug-theme/route.ts                # お題確認 API
│   ├── api/generate-comment/route.ts           # AI コメント生成 API
│   ├── api/grid/[shareId]/route.tsx            # 9選 OGP 生成 API
│   ├── api/image-proxy/route.ts                # 画像プロキシ API
│   ├── api/myPosts/route.ts                    # 投稿一覧取得 API
│   ├── api/nine-ogp/[shareId]/route.ts         # 9選補助 API
│   ├── api/og/[recordId]/route.tsx             # 投稿 OGP 生成 API
│   ├── auth/login/page.tsx                     # `/login` への転送ページ
│   ├── nine/page.tsx                           # 空の補助ページ
│   ├── nine/[shareId]/layout.tsx               # 9選レイアウト
│   ├── nine/[shareId]/page.tsx                 # 9選共有ページ
│   ├── profile/page.tsx                        # アカウント設定ページ
│   ├── record/[recordId]/page.tsx              # 投稿詳細ページ
│   └── share/[recordId]/page.tsx               # 外部共有ページ
├── assets/
│   └── badge_ogp.png                           # 補助画像
├── components/
│   ├── CreateRecordForm.tsx                    # 投稿作成フォーム
│   ├── FirebaseSecurityDiagnostic.tsx          # Storage 診断 UI
│   ├── HistoryGrid.tsx                         # 9選選択グリッド
│   ├── ImageUploadArea.tsx                     # 画像入力 UI
│   ├── OgpCropper.tsx                          # OGP トリミング UI
│   ├── RecordList.tsx                          # 投稿一覧
│   ├── ShareButton.tsx                         # X 共有ボタン
│   ├── SharePostClient.tsx                     # 投稿共有クライアント UI
│   └── StatsDisplay.tsx                        # 統計表示
├── contexts/
│   └── AuthContext.tsx                         # 認証状態共有
├── hooks/                                      # 現在は空
├── lib/
│   ├── firebase.ts                             # Firebase クライアント初期化
│   ├── firebaseAdmin.ts                        # Firebase Admin 初期化
│   ├── getCurrentWeeklyTheme.ts                # 現在のお題取得
│   ├── growth.ts                               # 成長データ計算
│   ├── stats.ts                                # 統計計算
│   ├── twitter.ts                              # X 投稿文生成
│   └── utils.ts                                # 共通ユーティリティ
├── public/
│   ├── egaken.png                              # アイコン画像
│   ├── file.svg                                # 補助 SVG
│   ├── globe.svg                               # 補助 SVG
│   ├── next.svg                                # 補助 SVG
│   ├── ogp.png                                 # フォールバック OGP
│   ├── top-ogp.png                             # トップ OGP
│   ├── top-ogp_test.png                        # OGP テスト出力
│   ├── top-ogp_tmp.png                         # OGP 一時出力
│   ├── vercel.svg                              # 補助 SVG
│   └── window.svg                              # 補助 SVG
└── scripts/
    └── generate-top-ogp.js                     # トップ OGP 生成スクリプト
```

---

## 開発コマンド

```bash
npm run dev
npm run build
npm start
npm run lint
```

---

## セキュリティと運用上の注意

- `.env.local` とサービスアカウント JSON は Git に含めない
- 本番では `FIREBASE_SERVICE_ACCOUNT_KEY` を環境変数で管理する
- Storage の書き込み上限とフロントのファイル制限を一致させる
- Firestore と Storage のセキュリティルールは Firebase Console 側で必ず設定する
- 公開共有用の 9選画像は Storage 上で公開 URL として配信される
- `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET` と実バケット名の不一致があると OGP や画像取得で失敗しやすい

---

## 既知の注意点

- `app/api/nine-ogp/[shareId]/route.ts` は `POST /api/createNine` の主経路とは別の補助実装です。直接呼ばれることは通常ありません。
- `app/nine/page.tsx` は実質空ファイルです。`/nine` への直接アクセスは想定していません。

---

## トラブルシュート

### ログインできない

- Firebase Authentication で Google とメール / パスワードが有効か確認
- Google ログインをアプリ内ブラウザで試していないか確認
- `NEXT_PUBLIC_FIREBASE_*` の値が正しいか確認

### 画像アップロードに失敗する

- Storage が有効化されているか確認
- ファイル形式が PNG / JPEG / WebP / GIF のいずれかか確認
- サイズが 5MB 以下か確認
- Storage ルールとフロント側制限が一致しているか確認

### AI コメントが付かない

- `OPENAI_API_KEY` を確認
- サーバーログで `/api/generate-comment` の失敗を確認
- 投稿保存自体は成功していても、AI 生成だけ失敗している可能性があります

### 共有画像が意図通り出ない

- `showOgp` がオフになっていないか確認
- ページ URL 側の `v` パラメータを更新して再取得を試す
- OGP トリミング指定が極端な範囲になっていないか確認

### 9選生成に失敗する

- ちょうど 9 枚選択しているか確認
- Admin SDK が初期化できているか確認
- Storage バケット名とサービスアカウント権限を確認

### 週間お題が出ない

- `weeklyThemes` に `startAt`, `endAt` があるか確認
- 現在時刻が期間内か確認
- `/debug-theme` で時刻判定を確認

---

## ライセンス

MIT License