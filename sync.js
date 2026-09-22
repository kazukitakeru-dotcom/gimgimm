'use strict';
/* ============================================================================
   IRON LOG — 複数端末同期（Supabase）

   わんにゃんメモリー・達人への道と同じ Supabase プロジェクトに相乗りする。
   テーブルは supabase.sql を参照（ironlog_state / ironlog_logs / ironlog_cardio）。

   設計
     - ログと有酸素は1件1行。IDごとに last-write-wins なので端末間で潰し合わない
     - 種目リストと設定は小さな JSON 1行（ironlog_state）で last-write-wins
     - 削除は行を消さず deleted フラグを立てる（他端末に削除を伝えるため）
     - 未ログインなら何もしない＝導入前とまったく同じ挙動
     - 外部ライブラリ不使用（PWAをオフラインで完結させるため fetch で直接叩く）
   ========================================================================== */

const SB_URL = 'https://kafaarlosuvqxxlxpvgg.supabase.co';
/* publishable key は公開前提のもの。これ単体では何も読めない（anon は revoke 済み）。 */
const SB_KEY = 'sb_publishable_nSwOQo-YbEtDN_KTjBf80w_D6o0iLoA';

// ログイン状態は6アプリで共通。同じオリジンなので localStorage を共有できる。
// キーを分けていたせいで、アプリの数だけログインが必要になっていた。
const SESSION_KEY    = 'sb_session_v1';
const LEGACY_SESSION_KEY = 'ironlog_session_v1';
const SYNC_STATE_KEY = 'ironlog_sync_state_v1';

/* ── セッション ───────────────────────────────────────────────────────── */
function sbLoadSession() {
  try {
    let raw = localStorage.getItem(SESSION_KEY);
    // 旧キー（アプリごとに分かれていた頃のもの）からの引き継ぎ。
    // これがあるので、共通化のためにログインし直す必要はない。
    if (!raw) {
      const old = localStorage.getItem(LEGACY_SESSION_KEY);
      // 引き継いだら古いほうは必ず消す。残すとログアウトした瞬間に古いログイン情報が
      // ここから復活し、何週間も前の更新トークンを使ってサーバーにログインごと無効にされていた
      if (old) { localStorage.setItem(SESSION_KEY, old); localStorage.removeItem(LEGACY_SESSION_KEY); raw = old; }
    }
    return JSON.parse(raw || 'null');
  } catch (e) { return null; }
}
/* アプリごとに分かれていた頃のログイン情報の置き場所。6アプリは同じオリジンで保存先を共有しているので、
   どのアプリの古いキーが残っていても、ログアウトや失効のあとに古いログイン情報が復活してしまう。
   ログインした時もログアウトした時も、全部まとめて消す。 */
const LEGACY_SESSION_KEYS = ['ironlog_session_v1', 'wannyan_session_v1', 'uruoi_session_v1', 'qest_session_v1', 'kaimono_session_v1'];

function sbSaveSession(s) {
  if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s));
  else localStorage.removeItem(SESSION_KEY);
  LEGACY_SESSION_KEYS.forEach(k => { try { localStorage.removeItem(k); } catch (e) {} });
}
function sbIsLoggedIn() { return !!(sbLoadSession() || {}).refresh_token; }

/* 最後にログインしたメールアドレス。ログイン欄にあらかじめ入れておくためだけのもので、
   パスワードは持たない（パスワードは端末のパスワード保存に任せる）。
   キーは他アプリと共通なので、どれか1つで入れれば他アプリの欄にも入っている。 */
const LAST_EMAIL_KEY = 'sb_last_email';
function lastLoginEmail() {
  return (sbLoadSession() || {}).email || localStorage.getItem(LAST_EMAIL_KEY) || '';
}
function rememberLoginEmail(email) {
  try { localStorage.setItem(LAST_EMAIL_KEY, email); } catch (e) {}
}

function _storeSession(json) {
  if (!json || !json.access_token) return null;
  const prev = sbLoadSession() || {};
  const s = {
    access_token:  json.access_token,
    refresh_token: json.refresh_token,
    expires_at:    Date.now() + (json.expires_in || 3600) * 1000,
    user_id:       (json.user && json.user.id)    || prev.user_id || null,
    email:         (json.user && json.user.email) || prev.email   || null,
  };
  sbSaveSession(s);
  return s;
}

/* 原因が分かりやすいものだけ日本語にする */
function sbMessage(raw) {
  const s = String(raw || '');
  if (/invalid login credentials/i.test(s))   return 'メールアドレスかパスワードが違います';
  if (/email not confirmed/i.test(s))         return 'メールの確認がまだです。届いた確認メールのリンクを開いてください';
  if (/user already registered/i.test(s))     return 'このメールアドレスは登録済みです。ログインしてください';
  if (/password should be at least/i.test(s)) return 'パスワードが短すぎます（6文字以上）';
  if (/rate limit|too many/i.test(s))         return '試行が多すぎます。少し待ってからやり直してください';
  if (/schema cache|does not exist/i.test(s)) return 'テーブルがまだ作られていません（supabase.sql を実行してください）';
  if (/permission denied/i.test(s))           return 'テーブルの権限設定が足りません（supabase.sql を実行してください）';
  return s;
}

/* fetch 自体が失敗した（サーバーから返事すら来なかった）ときに、原因を切り分けて返す。
   - 端末がオフライン                        → 「オフライン」
   - 自分のページの置き場所にも届かない      → 「ネットワークに接続できません」
   - ネットはつながるのに同期サーバーだけ届かない → サーバー停止の可能性
   Supabase の無料枠は7日間どのアプリからもアクセスがないとプロジェクトが一時停止し、
   アドレス自体が引けなくなって fetch が失敗する（2026-09-15 に実際に起きた）。
   以前はどれも「ネットワークに接続できません」と出ていて原因が分からなかった。
   status を付けないのは、呼び出し側が「通信エラー＝ログイン情報を捨てない」と判断するため。 */
async function _unreachableError() {
  if (!navigator.onLine) return new Error('オフライン');
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 5000);
  try {
    // ?probe= を付けて Service Worker のキャッシュに当たらないようにする
    await fetch(`./manifest.json?probe=${Date.now()}`, { cache: 'no-store', signal: ctl.signal });
  } catch {
    return new Error('ネットワークに接続できません');
  } finally {
    clearTimeout(timer);
  }
  return new Error('同期サーバーに接続できません。サーバーが一時停止している可能性があります');
}

async function _authFetch(path, body) {
  let res;
  try {
    res = await fetch(`${SB_URL}/auth/v1/${path}`, {
      method: 'POST',
      headers: { 'apikey': SB_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch { throw await _unreachableError(); }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    // 「サーバーに断られた」のか「そもそも届かなかった」のかを呼び出し側が区別できるように
    // status を付ける。混同するとオフラインなだけでログイン情報を捨ててしまう。
    const err = new Error(sbMessage(json.error_description || json.msg || json.message || `HTTP ${res.status}`));
    err.status = res.status;
    throw err;
  }
  return json;
}

async function sbSignUp(email, password) {
  const json = await _authFetch('signup', { email, password });
  if (!json.access_token) return { needsConfirmation: true };  // 確認メール待ち
  _storeSession(json);
  return { needsConfirmation: false };
}

async function sbSignIn(email, password) {
  _storeSession(await _authFetch('token?grant_type=password', { email, password }));
}

function sbSignOut() {
  sbSaveSession(null);
  localStorage.removeItem(SYNC_STATE_KEY);
}

/* 有効なアクセストークンを返す（期限が近ければ更新する）

   リフレッシュトークンは1回使うとサーバー側で作り替えられ、古いものはその場で無効になる。
   同期は複数のテーブルを Promise.all で同時に取りに行くので、何もしないと
   各リクエストが同時に「期限が切れているから更新しよう」と判断して同じトークンを何度も使い、
   1本だけ成功して残りは「Invalid Refresh Token: Already Used」で弾かれる。
   それを失効と誤解してログイン情報を消していたため、
   アクセストークンの寿命（1時間）を超えて間を空けるたびにログインし直しになっていた。
   _refreshing で更新は常に1本にまとめ、後続はその結果に相乗りする。 */
let _refreshing = null;

async function sbAccessToken() {
  const s = sbLoadSession();
  if (!s || !s.refresh_token) return null;
  if (s.access_token && Date.now() < s.expires_at - 60000) return s.access_token;
  if (!_refreshing) {
    _refreshing = _refreshExclusive().finally(() => { _refreshing = null; });
  }
  return _refreshing;
}

/* github.io の6アプリは同じオリジンなので、ログイン情報の保存先（sb_session_v1）を共有している。
   別のタブや別のアプリが同時に同じ更新トークンを使うと、Supabase はそれを「使い回し」とみなし、
   そのログインを丸ごと無効にすることがある（以後どのアプリでも Invalid Refresh Token: Already Used）。
   Web Locks でオリジン全体の更新を1本ずつに並べ、鍵が取れた時点で保存先を読み直す。
   待っている間に誰かが更新を済ませていれば、それをそのまま使う。 */
function _refreshExclusive() {
  const run = async () => {
    const s = sbLoadSession();
    if (!s || !s.refresh_token) throw new Error('ログインしていません');
    if (s.access_token && Date.now() < s.expires_at - 60000) return s.access_token;
    return _sbRefresh(s.refresh_token);
  };
  return (navigator.locks && navigator.locks.request)
    ? navigator.locks.request('sb-token-refresh', run)
    : run();
}

async function _sbRefresh(used) {
  try {
    const json = await _authFetch('token?grant_type=refresh_token', { refresh_token: used });
    return _storeSession(json).access_token;
  } catch (e) {
    // 同じオリジンの別アプリ／別タブが先に更新していた場合、保存先には既に新しいものが入っている。
    // これは失効ではないので、ログイン情報は捨てずに新しいほうで1回だけやり直す。
    const now = sbLoadSession();
    if (now && now.refresh_token && now.refresh_token !== used) {
      if (now.access_token && Date.now() < now.expires_at - 60000) return now.access_token;
      try {
        const json = await _authFetch('token?grant_type=refresh_token', { refresh_token: now.refresh_token });
        return _storeSession(json).access_token;
      } catch (e2) {
        e = e2;   // やり直しも断られたら、下で同じように扱う
      }
    }
    // サーバーがはっきり断ったときだけログインし直し。通信エラー（status 無し）では捨てない。
    // 以前は「やり直し」が断られたときにここを通らず、使えないログイン情報が残ったまま
    // 同期のたびに Invalid Refresh Token: Already Used が出続けていた。
    if (e.status === 400 || e.status === 401) {
      sbSaveSession(null);
      const err = new Error('ログインの有効期限が切れました。もう一度ログインしてください');
      err.status = e.status;
      throw err;
    }
    throw e;
  }
}

/* サーバー時刻でも「commit の順番」と now() は完全には一致しないので、
   前回取得位置を少しだけ巻き戻して取りこぼしを防ぐ。重複して取っても害はない。 */
const PULL_MARGIN_MS = 5000;
const PAGE_SIZE = 1000; /* PostgREST の1回あたり上限に合わせる */

/* ── PostgREST ────────────────────────────────────────────────────────── */
async function _rest(path, { method = 'GET', body = null, prefer = null } = {}) {
  const token = await sbAccessToken();
  if (!token) throw new Error('ログインしていません');
  const headers = {
    'apikey': SB_KEY,
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
  if (prefer) headers['Prefer'] = prefer;
  let res;
  try {
    res = await fetch(`${SB_URL}/rest/v1/${path}`, {
      method, headers, body: body ? JSON.stringify(body) : undefined,
    });
  } catch { throw await _unreachableError(); }
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(sbMessage(t) || `${res.status}`);
  }
  return (method === 'GET' || /return=representation/.test(prefer || '')) ? res.json() : null;
}

// 1回のGETには件数上限があるので、全部取れるまでページを送る。
// ログは続けるほど増えるので、ここが無いと 1000 件を超えたぶんが静かに落ちる
// （エラーにならないので気づけない）。
async function _restAll(path) {
  const out = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const page = await _rest(`${path}&limit=${PAGE_SIZE}&offset=${offset}`);
    out.push(...page);
    if (page.length < PAGE_SIZE) return out;
  }
}

/* ── 変更検出 ─────────────────────────────────────────────────────────── */
/* JSON全体を控えると重いので、短いハッシュで「変わったか」だけ見る */
function _hash(str) {
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 = ((h1 ^ c) * 16777619) >>> 0;
    h2 = ((h2 + c) * 31 + (h2 << 3)) >>> 0;
  }
  return h1.toString(36) + '-' + h2.toString(36) + '-' + str.length.toString(36);
}

/* jsonb はキーの順番を保たない。サーバーから戻ってきた内容と手元を比べるときは、
   キーを並べ替えてから文字列にしないと、中身が同じでも「違う」と判定してしまう。 */
function _stable(v) {
  if (Array.isArray(v)) return '[' + v.map(x => (x === undefined ? 'null' : _stable(x))).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).filter(k => v[k] !== undefined).sort()
      .map(k => JSON.stringify(k) + ':' + _stable(v[k])).join(',') + '}';
  }
  return JSON.stringify(v);
}
function _exHash(list) { return _hash(_stable(list || [])); }

function _loadSyncState() {
  try {
    const s = JSON.parse(localStorage.getItem(SYNC_STATE_KEY) || 'null');
    if (s && typeof s === 'object') {
      // 2026-08-06: updated_at を端末の時計からサーバー時刻に切り替えた。
      // 切り替え前の lastPulledAt はずれた時計で書かれた値なので、
      // そのまま基準にすると（時計が進んでいた端末では）何も取れなくなる。
      // 1度だけ全件取り直させる。
      if (!s.serverTimeMigrated) { s.lastPulledAt = null; s.serverTimeMigrated = true; }
      return s;
    }
  } catch {}
  return { lastPulledAt: null, logs: {}, cardio: {}, stateRowAt: null, remoteDocHash: null,
           touched: {}, serverTimeMigrated: true };
}
function _saveSyncState(s) {
  try { localStorage.setItem(SYNC_STATE_KEY, JSON.stringify(s)); } catch {}
}

/* ── 同期本体 ─────────────────────────────────────────────────────────── */
let _syncing = false;
let _syncTimer = null;
let _lastSyncError = null;

function scheduleSync(delay = 2500) {
  if (!sbIsLoggedIn()) return;
  clearTimeout(_syncTimer);
  _syncTimer = setTimeout(() => { syncNow().catch(() => {}); }, delay);
}

async function syncNow(opts = {}) {
  if (_syncing || !sbIsLoggedIn()) return;
  if (!navigator.onLine) { _lastSyncError = 'オフライン'; updateSyncUI(); return; }

  _syncing = true;
  updateSyncUI();
  let changed = false;
  try {
    const state = _loadSyncState();
    changed = await _pull(state);
    if (await _push(state)) changed = true;
    state.lastSyncedAt = Date.now();
    _saveSyncState(state);
    _lastSyncError = null;
    if (opts.toast) window.IRONLOG.helpers.showToast('☁️ 同期しました');
  } catch (e) {
    _lastSyncError = e.message || String(e);
    if (opts.toast) window.IRONLOG.helpers.showToast('⚠️ 同期に失敗：' + _lastSyncError);
  } finally {
    _syncing = false;
    if (changed) window.IRONLOG.rerender();   // rerender の中で updateSyncUI が呼ばれる
    else updateSyncUI();
  }
}


/* ── 種目リストと設定のマージ ─────────────────────────────────────────────
   一覧まるごと「新しく同期したほう」で上書きしていたため、片方の端末で足した種目や
   しまった印が、もう片方で別の種目を触っただけで消えていた（2026-09-22）。
   種目は1件ずつ、設定は1項目ずつ、あとから変えたほうを採る。
     - 種目: updatedAt が大きいほう。同じなら（変更記録の無い古いデータ同士）サーバー
     - 消した種目: 墓標（exDeleted）の時刻がその種目の updatedAt 以降なら消す
     - 並び順: exOrderAt が新しいほうの並びを基本に、足りない種目を後ろへ
     - 設定: settingsAt[項目] が大きいほう。同じならサーバーに値があればサーバー */
function _localStateDoc() {
  const I = window.IRONLOG;
  return { exercises: I.getExercises(), exDeleted: I.getExTombstones(), exOrderAt: I.getExOrderAt(),
           settings: I.getSettings(), settingsAt: I.getSettingsAt() };
}
function _remoteStateDoc(doc) {
  doc = doc || {};
  return { exercises: Array.isArray(doc.exercises) ? doc.exercises : [], exDeleted: doc.exDeleted || {},
           exOrderAt: doc.exOrderAt || 0, settings: doc.settings || null, settingsAt: doc.settingsAt || {} };
}
function _mergeStateDocs(a, b) {   // a = この端末、b = サーバー
  const tomb = Object.assign({}, b.exDeleted);
  Object.entries(a.exDeleted || {}).forEach(([id, t]) => { if (!(tomb[id] >= t)) tomb[id] = t; });

  const byId = new Map();
  b.exercises.forEach(ex => byId.set(String(ex.id), ex));
  a.exercises.forEach(ex => {
    const id = String(ex.id), cur = byId.get(id);
    if (!cur || (ex.updatedAt || 0) > (cur.updatedAt || 0)) byId.set(id, ex);
  });
  for (const [id, ex] of [...byId]) {
    if (tomb[id] != null && tomb[id] >= (ex.updatedAt || 0)) byId.delete(id);
  }
  const first  = (b.exOrderAt || 0) > (a.exOrderAt || 0) ? b : a;
  const second = first === a ? b : a;
  const exercises = [], seen = new Set();
  [...first.exercises, ...second.exercises].forEach(ex => {
    const id = String(ex.id);
    if (byId.has(id) && !seen.has(id)) { seen.add(id); exercises.push(byId.get(id)); }
  });

  const as = a.settings || {}, bs = b.settings || {};
  const settings = {}, settingsAt = {};
  new Set([...Object.keys(as), ...Object.keys(bs)]).forEach(k => {
    const ta = (a.settingsAt || {})[k] || 0, tb = (b.settingsAt || {})[k] || 0;
    const bSet = bs[k] != null && bs[k] !== 0 && bs[k] !== '';
    const useB = !(k in as) || tb > ta || (tb === ta && bSet && (k in bs));
    settings[k]   = useB ? bs[k] : as[k];
    settingsAt[k] = Math.max(ta, tb);
  });

  return { exercises, exDeleted: tomb, exOrderAt: Math.max(a.exOrderAt || 0, b.exOrderAt || 0),
           settings, settingsAt };
}

/* サーバーの行を手元に取り込む。手元が変わったら true */
function _applyRemoteState(state, row) {
  const I = window.IRONLOG;
  state.stateRowAt = row ? row.updated_at : null;
  const remote = _remoteStateDoc(row && row.doc);
  state.remoteDocHash = row ? _hash(_stable(remote)) : null;
  const local  = _localStateDoc();
  // 新しい端末に最初から入っている見本の3種目（一度も触っていないもの）は、初めての同期に限り、
  // サーバーに無ければ混ぜない（混ぜると全端末の一覧に見本が紛れ込む）。
  // 見本をそのまま使い続けている本物の種目（例：番号1のベンチプレス）もあるので、
  // 同期済みの端末や、サーバーに同じ番号がある場合は除外しない。
  // 以前は常に除外していたため、本物のベンチプレスが同期のたびに一番下へ回されていた。
  const SEED = { 1: 'ベンチプレス', 2: 'スクワット', 3: 'デッドリフト' };
  const firstSync = !state.lastSyncedAt && !state.remoteDocHashSeen;
  if (firstSync && remote.exercises.length) {
    const remoteIds = new Set(remote.exercises.map(x => String(x.id)));
    local.exercises = local.exercises.filter(x => x.updatedAt || SEED[x.id] !== x.name || remoteIds.has(String(x.id)));
  }
  if (row) state.remoteDocHashSeen = true;
  const merged = _mergeStateDocs(local, remote);
  let changed = false;
  if (_exHash(merged.exercises) !== _exHash(I.getExercises())) { I.setExercises(merged.exercises); changed = true; }
  I.setExMeta(merged.exDeleted, merged.exOrderAt);
  if (_hash(_stable(merged.settings)) !== _hash(_stable(local.settings))) {
    I.setSettings(merged.settings, merged.settingsAt); changed = true;
  } else {
    I.setSettings(local.settings, merged.settingsAt);
  }
  return changed;
}

/* 行を書き込む。前回読んだあとで他の端末が書いていたら false（書かない）。
   読んでから書くまでの間に他の端末が書いた内容を、黙って上書きしないため。 */
async function _writeState(state, doc, userId) {
  if (state.stateRowAt) {
    const rows = await _rest(`ironlog_state?user_id=eq.${userId}&updated_at=eq.${encodeURIComponent(state.stateRowAt)}`, {
      method: 'PATCH', prefer: 'return=representation', body: { doc },
    });
    if (!rows || !rows.length) return false;
    state.stateRowAt = rows[0].updated_at;
    return true;
  }
  const rows = await _rest('ironlog_state?on_conflict=user_id', {
    method: 'POST', prefer: 'resolution=merge-duplicates,return=representation',
    body: [{ user_id: userId, doc }],
  });
  state.stateRowAt = rows && rows[0] ? rows[0].updated_at : null;
  return true;
}

/* ---- 取得 ---- */
async function _pull(state) {
  const since = state.lastPulledAt ? `&updated_at=gt.${encodeURIComponent(state.lastPulledAt)}` : '';
  const [stateRows, logRows, cardioRows] = await Promise.all([
    _rest('ironlog_state?select=doc,updated_at&limit=1'),
    _restAll(`ironlog_logs?select=id,date,clock,entries,total,updated_at,deleted&order=updated_at.asc,id.asc${since}`),
    _restAll(`ironlog_cardio?select=id,date,clock,data,updated_at,deleted&order=updated_at.asc,id.asc${since}`),
  ]);

  let newest = state.lastPulledAt;
  const bump = ts => { if (ts && (!newest || ts > newest)) newest = ts; };
  let changed = false;

  /* --- 種目リストと設定（1件ずつ・1項目ずつマージ） --- */
  if (_applyRemoteState(state, stateRows && stateRows[0])) changed = true;

  /* --- 筋トレのログ --- */
  if (logRows && logRows.length) {
    const list = [...window.IRONLOG.getLogs()];
    logRows.forEach(r => {
      bump(r.updated_at);
      const touched = state.touched[r.id];
      if (touched && touched > Date.parse(r.updated_at)) return;   // ローカルの未送信分の方が新しい
      // 自分が送った行が返ってきただけなら何もしない
      const incoming = _rowToLog(r);
      if (!r.deleted && state.logs[r.id] === _hash(JSON.stringify(incoming))) return;
      if (r.deleted && !state.logs[r.id]) return;
      const i = list.findIndex(l => String(l.id) === String(r.id));
      if (i !== -1) list.splice(i, 1);
      if (!r.deleted) {
        list.push(incoming);
        state.logs[r.id] = _hash(JSON.stringify(incoming));
      } else {
        delete state.logs[r.id];
      }
      delete state.touched[r.id];
      changed = true;
    });
    window.IRONLOG.setLogs(list);
  }

  /* --- 有酸素 --- */
  if (cardioRows && cardioRows.length) {
    const list = [...window.IRONLOG.getCardioLogs()];
    cardioRows.forEach(r => {
      bump(r.updated_at);
      const key = 'c:' + r.id;
      const touched = state.touched[key];
      if (touched && touched > Date.parse(r.updated_at)) return;
      const incoming = { ...(r.data || {}), id: r.id, date: r.date, time: r.clock || '' };
      if (!r.deleted && state.cardio[r.id] === _hash(JSON.stringify(incoming))) return;
      if (r.deleted && !state.cardio[r.id]) return;
      const i = list.findIndex(c => String(c.id) === String(r.id));
      if (i !== -1) list.splice(i, 1);
      if (!r.deleted) {
        list.push(incoming);
        state.cardio[r.id] = _hash(JSON.stringify(incoming));
      } else {
        delete state.cardio[r.id];
      }
      delete state.touched[key];
      changed = true;
    });
    window.IRONLOG.setCardioLogs(list);
  }

  // commit の順と now() のわずかなズレで取りこぼさないよう、少しだけ巻き戻す
  if (newest) state.lastPulledAt = new Date(Date.parse(newest) - PULL_MARGIN_MS).toISOString();
  return changed;
}

/* ハッシュ比較に使う正規形（ローカルの形）。
   DB側は time が予約語なので clock 列に入れている。 */
function _logRow(l) {
  return { id: String(l.id), date: l.date, time: l.time || '', entries: l.entries || [], total: l.total || 0 };
}
function _rowToLog(r) {
  return { id: String(r.id), date: r.date, time: r.clock || '', entries: r.entries || [], total: r.total || 0 };
}

/* ---- 送信 ---- */
async function _push(state) {
  const userId = (sbLoadSession() || {}).user_id;
  if (!userId) throw new Error('ユーザーIDが取れません');

  /* --- 種目リストと設定 ---
     マージ済みの手元がサーバーと違えば書く。書く直前に他の端末が書いていたら、
     読み直してもう一度マージしてから書く（最大3回）。
     doc は丸ごと置き換わるので、種目・墓標・並び順・設定は必ず一緒に送る。 */
  let changed = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    const doc = _localStateDoc();
    const h = _hash(_stable(doc));
    if (h === state.remoteDocHash) break;
    if (await _writeState(state, doc, userId)) { state.remoteDocHash = h; break; }
    const rows = await _rest('ironlog_state?select=doc,updated_at&limit=1');
    if (_applyRemoteState(state, rows && rows[0])) changed = true;
  }

  /* --- 筋トレのログ --- */
  const logs = window.IRONLOG.getLogs();
  const rows = [];
  const seen = new Set();
  logs.forEach(l => {
    const id = String(l.id);
    seen.add(id);
    const r = _logRow(l);
    if (state.logs[id] === _hash(JSON.stringify(r))) return;
    rows.push({ user_id: userId, id, date: r.date, clock: r.time,
                entries: r.entries, total: r.total, deleted: false });
  });
  Object.keys(state.logs).forEach(id => {
    if (seen.has(id)) return;   // ローカルで消えた＝他端末にも削除を伝える
    rows.push({ user_id: userId, id, date: '1970-01-01', clock: '', entries: [], total: 0,
                deleted: true });
  });
  for (let i = 0; i < rows.length; i += 200) {
    await _rest('ironlog_logs?on_conflict=user_id,id', {
      method: 'POST', prefer: 'resolution=merge-duplicates,return=minimal',
      body: rows.slice(i, i + 200),
    });
  }
  rows.forEach(r => {
    if (r.deleted) delete state.logs[r.id];
    else state.logs[r.id] = _hash(JSON.stringify(_rowToLog(r)));
    delete state.touched[r.id];
  });

  /* --- 有酸素 --- */
  const cardio = window.IRONLOG.getCardioLogs();
  const cRows = [];
  const cSeen = new Set();
  cardio.forEach(c => {
    const id = String(c.id);
    cSeen.add(id);
    if (state.cardio[id] === _hash(JSON.stringify(c))) return;
    const { id: _i, date: _d, time: _t, ...rest } = c;
    cRows.push({ user_id: userId, id, date: c.date, clock: c.time || '', data: rest,
                 deleted: false });
  });
  Object.keys(state.cardio).forEach(id => {
    if (cSeen.has(id)) return;
    cRows.push({ user_id: userId, id, date: '1970-01-01', clock: '', data: {},
                 deleted: true });
  });
  for (let i = 0; i < cRows.length; i += 200) {
    await _rest('ironlog_cardio?on_conflict=user_id,id', {
      method: 'POST', prefer: 'resolution=merge-duplicates,return=minimal',
      body: cRows.slice(i, i + 200),
    });
  }
  cRows.forEach(r => {
    if (r.deleted) delete state.cardio[r.id];
    else state.cardio[r.id] = _hash(JSON.stringify({ ...r.data, id: r.id, date: r.date, time: r.clock }));
    delete state.touched['c:' + r.id];
  });
  return changed;
}

/* ── app.js からの保存通知 ────────────────────────────────────────────── */
/* 未送信のローカル変更に印をつけておき、pull で潰されないようにする */
window.onIronLogSaved = function (kind) {
  if (!sbIsLoggedIn()) return;
  try {
    const state = _loadSyncState();
    const now = Date.now();
    if (kind === 'logs') {
      window.IRONLOG.getLogs().forEach(l => {
        const id = String(l.id);
        if (state.logs[id] !== _hash(JSON.stringify(_logRow(l)))) state.touched[id] = now;
      });
    } else if (kind === 'cardio') {
      window.IRONLOG.getCardioLogs().forEach(c => {
        const id = String(c.id);
        if (state.cardio[id] !== _hash(JSON.stringify(c))) state.touched['c:' + id] = now;
      });
    }
    _saveSyncState(state);
  } catch {}
  scheduleSync();
};

/* ── 画面 ─────────────────────────────────────────────────────────────── */
window.onIronLogRender = function () { updateSyncUI(); };

function updateSyncUI() {
  const box = document.getElementById('sync-card-body');
  if (!box) return;
  const s = sbLoadSession();

  if (!s) {
    box.innerHTML = `
      <p class="transfer-desc">
        ログインすると、iPhone・iPad・PC など複数の端末で記録を共有できます。<br>
        ログインしなければ今までどおり、この端末だけに保存されます。
      </p>
      <button class="btn-export" id="sync-login-btn">
        <span class="transfer-btn-icon">🔑</span>ログイン / 新規登録
      </button>`;
    document.getElementById('sync-login-btn').addEventListener('click', openSyncLogin);
    return;
  }

  const st   = _loadSyncState();
  const last = st.lastSyncedAt ? new Date(st.lastSyncedAt).toLocaleString('ja-JP') : 'まだ';
  const status = _syncing ? '同期中…'
    : _lastSyncError ? `⚠️ 同期できていません（${_lastSyncError}）`
    : `最終同期 ${last}`;

  box.innerHTML = `
    <div class="sync-status${_lastSyncError ? ' error' : ' ok'}">
      ${window.IRONLOG.helpers.esc(s.email || '')}<br>${window.IRONLOG.helpers.esc(status)}
    </div>
    <button class="btn-export" id="sync-now-btn" ${_syncing ? 'disabled' : ''}>
      <span class="transfer-btn-icon">🔄</span>今すぐ同期
    </button>
    <button class="btn-delete-all" id="sync-logout-btn" style="margin-top:10px">
      <span class="transfer-btn-icon">🚪</span>ログアウト
    </button>`;

  document.getElementById('sync-now-btn').addEventListener('click', () => syncNow({ toast: true }));
  document.getElementById('sync-logout-btn').addEventListener('click', () => {
    if (!confirm('ログアウトします。ログインを共有している他のアプリもログアウトになります。\nこの端末のデータはそのまま残ります。よろしいですか？')) return;
    sbSignOut();
    updateSyncUI();
    window.IRONLOG.helpers.showToast('ログアウトしました');
  });
}

function openSyncLogin() {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-sheet">
      <div class="modal-pill"></div>
      <div class="modal-title">同期にログイン</div>
      <p class="transfer-desc">
        初めての端末では「新規登録」を、2台目以降は同じメールアドレスで「ログイン」を選んでください。
      </p>

      <!-- 入力欄は必ず form の中に置くこと。
           iPhone / Mac のパスワード保存（iCloudキーチェーン）は submit を合図に
           「保存しますか？」を出すので、フォームでないと候補として出てこない。
           ログインだけ type="submit"、他は type="button" にする。 -->
      <form id="sync-login-form" autocomplete="on" style="margin:0">
        <label class="form-label">メールアドレス</label>
        <input class="form-input" id="sync-email" name="email" type="email" autocomplete="username"
               inputmode="email" placeholder="you@example.com"
               value="${window.IRONLOG.helpers.esc(lastLoginEmail())}" />

        <label class="form-label">パスワード</label>
        <input class="form-input" id="sync-password" name="password" type="password" autocomplete="current-password"
               placeholder="8文字以上" />

        <div class="sync-login-msg" id="sync-login-msg"></div>

        <div class="modal-btn-row">
          <button class="btn-cancel"  id="sync-signup" type="button">新規登録</button>
          <button class="btn-confirm" id="sync-signin" type="submit">ログイン</button>
        </div>
        <button class="btn-cancel" id="sync-close" style="width:100%;margin-top:10px" type="button">閉じる</button>
      </form>
    </div>`;
  document.body.appendChild(overlay);

  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  overlay.querySelector('#sync-close').addEventListener('click', () => overlay.remove());

  const submit = async (mode) => {
    const email    = overlay.querySelector('#sync-email').value.trim();
    const password = overlay.querySelector('#sync-password').value;
    const msg      = overlay.querySelector('#sync-login-msg');
    if (!email || !password) { msg.textContent = 'メールアドレスとパスワードを入力してください'; return; }
    if (mode === 'signup' && password.length < 8) { msg.textContent = 'パスワードは8文字以上にしてください'; return; }
    msg.textContent = mode === 'signup' ? '登録中…' : 'ログイン中…';
    try {
      if (mode === 'signup') {
        const r = await sbSignUp(email, password);
        if (r.needsConfirmation) {
          msg.textContent = '確認メールを送りました。リンクを開いてから「ログイン」してください。';
          return;
        }
      } else {
        await sbSignIn(email, password);
      }
      rememberLoginEmail(email);
      overlay.remove();
      updateSyncUI();
      await syncNow({ toast: true });
    } catch (e) {
      msg.textContent = 'できませんでした：' + (e.message || e);
    }
  };

  overlay.querySelector('#sync-signup').addEventListener('click', () => submit('signup'));
  // ログインは click ではなく submit で受ける（そうしないとパスワード保存の候補に載らない）
  overlay.querySelector('#sync-login-form').addEventListener('submit', e => {
    e.preventDefault();
    submit('signin');
  });
}

/* ── 同期のきっかけ ───────────────────────────────────────────────────── */
window.addEventListener('online', () => scheduleSync(500));
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') scheduleSync(300);
});
window.addEventListener('load', () => {
  updateSyncUI();
  scheduleSync(1200);
});
