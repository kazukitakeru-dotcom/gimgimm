# IRON LOG（筋トレ記録PWA）— 作業メモ

GitHub Pages 想定の**静的サイト（ビルド無し・バックエンド無し）**。
iPhone のホーム画面に追加して使う。classic script なので `import` は使わない。

## 構成

| ファイル | 役割 |
|---|---|
| `index.html` | `app.js` → `obsidian.js` → `sync.js` の順に読み込むだけ |
| `app.js` | 画面とデータの本体。文字列テンプレートで全部描画して `render()` で差し替える |
| `obsidian.js` | Obsidian用Markdown書き出し（ZIPは無圧縮storeを自前で組み立て） |
| `aitext.js` | 記録をAIに貼れるテキストにして書き出す（クリップボード）|
| `sync.js` | Supabase同期。外部ライブラリを使わず `fetch` で直接叩く |
| `supabase.sql` | 同期用テーブル定義。何度実行しても壊れない |

## データ（localStorage）

| キー | 中身 |
|---|---|
| `exercises` | 種目リスト `{id, name, weight, targetSets, presetWeights, restSec, bodyweight, bwRatio, benched}`。`benched` は補欠ボックスにしまってある印（トレーニング画面には出さず、上の📦から開くモーダルで出し入れ。並び替えはレギュラー同士だけで入れ替える） |
| `settings_v1` | 共通設定 `{bodyWeight, defaultRestSec, customRestSec}`。`ironlog_state` の doc に種目リストと一緒に入れて同期する |
| `logs` | `{id, date:'YYYY-MM-DD', time:'HH:MM', entries, total}` を**新しい順**で |
| `cardioLogs` | 有酸素。`minutes` が運動時間、`time` は記録時刻（別物） |
| `session_v2` | 記録中のセット。保存すると空になる |
| `sessionMeta_v1` | `startDate`=記録を始めた日（不変） / `date`=保存先に選んだ日。日付をまたいだとき画面でどちらか選べる |
| `ironlog_session_v1` / `ironlog_sync_state_v1` | 同期のログイン情報と差分検出用（sync.js） |

**累計重量は保存していない。** `totalWeight()` が毎回 `logs` から計算する。
（以前は加算方式で、同じ日に2回保存すると二重計上されるバグがあった。）

旧形式（日本語の日付文字列・IDなし）は起動時に `migrateLogs` / `migrateCardio` が読み替える。

## 重量とレストタイマー

**扱う重量は `effectiveWeight(ex)` = 体重×`bwRatio`% ＋ `ex.weight`。**
`ex.bodyweight` が false なら `ex.weight` そのまま。自重ONの種目では
`ex.weight` の意味が「追加のオモリ（ディップスベルトなど）」に変わる。
セット記録時の値を `setList` に焼き込むので、あとで体重を変えても過去のログは動かない。

**レスト時間は `ex.restSec`（null なら `settings.defaultRestSec`）。**
`session` ではなく exercise 側に持たせてある。session に持たせていた頃は
ログを保存するたび（`session = {}`）に設定が消えていた。

- 秒数の変更は `timerSetSec(exId, sec, persist)` に集約。**計測中でも止めない。**
  `startEpoch` を保ったまま `cur = 新しい秒数 − 経過` を計算し直すので、残り時間だけが増減する
- モード切替も `timerSetMode()` が経過時間を引き継ぐ（止めない）
- ±15秒は `persist=false`。種目に保存されている秒数は変わらない
- `settings` を変えたら `refreshIdleTimers()` を呼ぶ。動いていないタイマーだけ新しい秒数に合わせる
- 種目モーダルは `paint()` で innerHTML を作り直す方式。**再描画の前に必ず `capture()`** で
  入力欄の値を `st` に退避すること（しないと打った内容が消える）。
  クリックは overlay への委譲で拾っているので、作り直してもハンドラは貼り直さなくてよい

## AIに貼る用のコピー（aitext.js）

数字だけ渡すとAIが読み違えるので、本文の先頭に必ず「読み方」を入れる
（総重量＝各セットの重量の合計／レップ数は記録していない／自重は合計に含まれている）。

- **クリップボードは同期的に呼ぶこと。** `navigator.clipboard.writeText()` の前に `await` を
  挟むとユーザー操作の文脈が切れて iOS で失敗する。`aiCopyText()` はクリックハンドラから
  直接呼ぶ形にしてある
- 失敗したら `execCommand('copy')` → それも駄目なら選択できる textarea を出す三段構え
- 範囲・オプションのモーダルは `paint()` で作り直す方式（種目モーダルと同じ）。
  入力欄が無く状態は `st` だけなので `capture()` は要らない

## 改修時の注意

- **`sw.js` の `CACHE_NAME` を必ずバンプする。** 上げないと古いキャッシュが配られて変更が効かない。
  新しいファイルは `ASSETS` 配列にも追加すること。
- **HTMLに値を埋めるときは必ず `esc()` を通す。** 種目名やメモに `"` や `<` が入ると表示が壊れる。
- **モーダルに項目を足したら `.modal-sheet` の高さを確認する。** 画面より高くなると
  保存ボタンに指が届かなくなる（`max-height: 88svh; overflow-y: auto` を入れてある）。
- `app.js` の state は `let` 宣言なので `window` から直接触れない。
  `obsidian.js` / `sync.js` からは **`window.IRONLOG`** 経由で読み書きする。
- 保存関数（`saveLogs` など）は `notifySaved()` を呼ぶ。sync.js がそれを拾って同期を予約する。
- ローカル確認は `python -m http.server` → **localhost** で開く。file:// だと Service Worker が動かない。
  localhost は本番と別オリジンなので実データには触れない（テスト投入も安全）。
  検証中は `getRegistrations().unregister()` ＋ `caches.delete()` してからリロードする。

## 同期（Supabase）

わんにゃんメモリー・達人への道と**同じプロジェクトに相乗り**している
（`https://kafaarlosuvqxxlxpvgg.supabase.co`）。publishable key は公開前提なのでソースに直書きでよい。

- テーブル: `ironlog_state`（doc に `{exercises, settings}`）/ `ironlog_logs` / `ironlog_cardio`
- **種目リストと設定は「前回そろえた内容のハッシュ」との3者比較で決める**（`state.exHash` / `state.stHash`）。
  サーバーだけ変わった→取り込む／この端末だけ変わった→送る／両方→この端末を優先して送る。
  **ハッシュは必ず `_stable()`（キーを並べ替えた文字列）で取ること。** jsonb はキー順を保たないので、
  キー順のまま取ると受け取った一覧を読み直しただけで「変更あり」と誤判定し、
  他端末の変更（補欠にしまった等）を古い一覧で上書きし返していた（2026-09-17 に修正）
- **doc は行ごと丸ごと置き換わる。種目リストと設定は必ず一緒に送る**（片方だけ送るともう片方が消える）
- 古い版のまま動き続ける端末があると上の上書きが再発するので、`app.js` で画面に戻るたびに
  Service Worker の更新を確認し、新しい版が引き継いだら1回読み直す。設定カードに端末の版を表示している
- **アクセストークンの更新は必ず1本にまとめること（`_refreshing`）。** 更新トークンは1回使うと
  サーバー側で作り替えられ、古いものはその場で無効になる。同期は複数テーブルを `Promise.all` で
  取りに行くので、まとめないと同じトークンを同時に3回使い、1本だけ成功して残りが400になる。
  それを失効と誤解してログイン情報を消していたため、**1時間以上あけて開くたびにログインし直し**
  になっていた。ログイン情報を捨てるのは status 400/401 のときだけ（通信エラーでは捨てない）
- **更新は Web Locks（`sb-token-refresh`）でオリジン全体に1本ずつ並べる。** 6アプリは同じ github.io
  オリジンで保存先を共有しているので、タブやアプリをまたいで同じ更新トークンを同時に使うと、
  Supabase が使い回しとみなしてログインを丸ごと無効にすることがある。鍵が取れたら保存先を読み直す
- 「別のアプリが先に更新していたので新しいほうでやり直す」処理が**やり直しまで断られたときも**
  ログイン情報を捨てること。以前はここだけ捨てずに投げていて、使えないログイン情報が残ったまま
  `Invalid Refresh Token: Already Used` が出続けた（2026-09-17）
- **アプリごとだった頃のログイン情報のキー（`*_session_v1`）は、引き継いだら消し、ログイン・ログアウトのたびに
  6アプリぶん全部消す**（`LEGACY_SESSION_KEYS`）。残していたせいで、ログアウトした瞬間に何週間も前の
  ログイン情報が復活してログイン画面が出ず、その古い更新トークンを使ってサーバーにログインごと
  無効にされていた（2026-09-17）
- **ログイン欄は `<form>` の中に置き、ログインボタンは `type="submit"`。** iPhone / Mac の
  パスワード保存は submit を合図に「保存しますか？」を出すので、div ＋ click だと候補に載らない
- ログと有酸素は**1件1行**。IDごとに独立なので端末間で潰し合わない
- 削除は行を消さず `deleted` フラグを立てる（他端末に削除を伝えるため）
- **新しいテーブルを足すときは毎回**「authenticated に grant ／ anon から revoke ／ RLS＋ポリシー」を
  明示的に書くこと（自動設定に頼らない構成にしてある）
- `time` は PostgreSQL の予約語なので、記録時刻の列名は **`clock`**
- 無料枠の実質的な制約は容量ではなく**7日間無操作でプロジェクト一時停止**
  （判定はプロジェクト単位なので、相乗りしている別アプリが叩いていれば止まらない）
  **2026-09-15 に実際に止まり**、全アプリで「ネットワークに接続できません」になった。対策を2つ入れてある:
  - `.github/workflows/supabase-keepalive.yml` が**毎日1回**、認証サーバーと6アプリのテーブルを叩く。
    アドレスが引けない（curl の終了コード6）＝停止とみなして失敗させ、GitHub の通知メールで気づけるようにした。
    公開リポジトリの定期実行は**60日コミットが無いと GitHub が自動で無効にする**ので注意
  - `sync.js` の `_unreachableError()` が、fetch 自体が失敗したときに
    自分の `manifest.json` へ届くかで切り分け、「同期サーバーに接続できません（一時停止の可能性）」と
    「ネットワークに接続できません」を出し分ける。**status を付けない**ので、ログイン情報は捨てない
