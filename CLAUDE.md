# IRON LOG（筋トレ記録PWA）— 作業メモ

GitHub Pages 想定の**静的サイト（ビルド無し・バックエンド無し）**。
iPhone のホーム画面に追加して使う。classic script なので `import` は使わない。

## 構成

| ファイル | 役割 |
|---|---|
| `index.html` | `app.js` → `obsidian.js` → `sync.js` の順に読み込むだけ |
| `app.js` | 画面とデータの本体。文字列テンプレートで全部描画して `render()` で差し替える |
| `obsidian.js` | Obsidian用Markdown書き出し（ZIPは無圧縮storeを自前で組み立て） |
| `sync.js` | Supabase同期。外部ライブラリを使わず `fetch` で直接叩く |
| `supabase.sql` | 同期用テーブル定義。何度実行しても壊れない |

## データ（localStorage）

| キー | 中身 |
|---|---|
| `exercises` | 種目リスト `{id, name, weight, targetSets, presetWeights}` |
| `logs` | `{id, date:'YYYY-MM-DD', time:'HH:MM', entries, total}` を**新しい順**で |
| `cardioLogs` | 有酸素。`minutes` が運動時間、`time` は記録時刻（別物） |
| `session_v2` | 記録中のセット。保存すると空になる |
| `sessionMeta_v1` | 記録を始めた日付。日付をまたいでも記録が動かないように持っている |
| `ironlog_session_v1` / `ironlog_sync_state_v1` | 同期のログイン情報と差分検出用（sync.js） |

**累計重量は保存していない。** `totalWeight()` が毎回 `logs` から計算する。
（以前は加算方式で、同じ日に2回保存すると二重計上されるバグがあった。）

旧形式（日本語の日付文字列・IDなし）は起動時に `migrateLogs` / `migrateCardio` が読み替える。

## 改修時の注意

- **`sw.js` の `CACHE_NAME` を必ずバンプする。** 上げないと古いキャッシュが配られて変更が効かない。
  新しいファイルは `ASSETS` 配列にも追加すること。
- **HTMLに値を埋めるときは必ず `esc()` を通す。** 種目名やメモに `"` や `<` が入ると表示が壊れる。
- `app.js` の state は `let` 宣言なので `window` から直接触れない。
  `obsidian.js` / `sync.js` からは **`window.IRONLOG`** 経由で読み書きする。
- 保存関数（`saveLogs` など）は `notifySaved()` を呼ぶ。sync.js がそれを拾って同期を予約する。
- ローカル確認は `python -m http.server` → **localhost** で開く。file:// だと Service Worker が動かない。
  localhost は本番と別オリジンなので実データには触れない（テスト投入も安全）。
  検証中は `getRegistrations().unregister()` ＋ `caches.delete()` してからリロードする。

## 同期（Supabase）

わんにゃんメモリー・達人への道と**同じプロジェクトに相乗り**している
（`https://kafaarlosuvqxxlxpvgg.supabase.co`）。publishable key は公開前提なのでソースに直書きでよい。

- テーブル: `ironlog_state`（種目リスト・LWW）/ `ironlog_logs` / `ironlog_cardio`
- ログと有酸素は**1件1行**。IDごとに独立なので端末間で潰し合わない
- 削除は行を消さず `deleted` フラグを立てる（他端末に削除を伝えるため）
- **新しいテーブルを足すときは毎回**「authenticated に grant ／ anon から revoke ／ RLS＋ポリシー」を
  明示的に書くこと（自動設定に頼らない構成にしてある）
- `time` は PostgreSQL の予約語なので、記録時刻の列名は **`clock`**
- 無料枠の実質的な制約は容量ではなく**7日間無操作でプロジェクト一時停止**
  （判定はプロジェクト単位なので、相乗りしている別アプリが叩いていれば止まらない）
