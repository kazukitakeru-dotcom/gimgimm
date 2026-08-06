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

const SESSION_KEY    = 'ironlog_session_v1';
const SYNC_STATE_KEY = 'ironlog_sync_state_v1';

/* ── セッション ───────────────────────────────────────────────────────── */
function sbLoadSession() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); } catch { return null; }
}
function sbSaveSession(s) {
  if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s));
  else localStorage.removeItem(SESSION_KEY);
}
function sbIsLoggedIn() { return !!(sbLoadSession() || {}).refresh_token; }

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

async function _authFetch(path, body) {
  let res;
  try {
    res = await fetch(`${SB_URL}/auth/v1/${path}`, {
      method: 'POST',
      headers: { 'apikey': SB_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch { throw new Error('ネットワークに接続できません'); }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(sbMessage(json.error_description || json.msg || json.message || `HTTP ${res.status}`));
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

async function sbAccessToken() {
  const s = sbLoadSession();
  if (!s || !s.refresh_token) return null;
  if (s.access_token && Date.now() < s.expires_at - 60000) return s.access_token;
  try {
    const json = await _authFetch('token?grant_type=refresh_token', { refresh_token: s.refresh_token });
    return _storeSession(json).access_token;
  } catch (e) {
    if (/invalid|expired|not found/i.test(e.message)) sbSaveSession(null);
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
  } catch { throw new Error('ネットワークに接続できません'); }
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(sbMessage(t) || `${res.status}`);
  }
  return method === 'GET' ? res.json() : null;
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
  return { lastPulledAt: null, logs: {}, cardio: {}, exHash: null, exAt: 0,
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
    await _push(state);
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

  /* --- 種目リスト・設定（last-write-wins） --- */
  const row = stateRows && stateRows[0];
  if (row && row.doc) {
    const remoteMs = Date.parse(row.updated_at);
    const local    = window.IRONLOG.getExercises();
    const localH   = _hash(JSON.stringify(local));
    const dirty    = state.exHash !== null && state.exHash !== localH;   // この端末で変えた
    if (Array.isArray(row.doc.exercises) && remoteMs > (state.exAt || 0) && !dirty) {
      let next = row.doc.exercises;
      if (state.exHash === null) {
        // 初回の同期。この端末にしかない種目を消さないように足しておく
        const ids = new Set(next.map(x => String(x.id)));
        next = [...next, ...local.filter(x => !ids.has(String(x.id)))];
      }
      window.IRONLOG.setExercises(next);
      state.exHash = _hash(JSON.stringify(next));
      state.exAt   = remoteMs;
      changed = true;
    }
  }

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

  /* --- 種目リスト --- */
  const exercises = window.IRONLOG.getExercises();
  const exHash = _hash(JSON.stringify(exercises));
  if (state.exHash !== exHash) {
    await _rest('ironlog_state?on_conflict=user_id', {
      method: 'POST',
      prefer: 'resolution=merge-duplicates,return=minimal',
      // updated_at は送らない。サーバー側のトリガが now() を入れる。
      body: [{ user_id: userId, doc: { exercises } }],
    });
    state.exHash = exHash;
    state.exAt   = Date.now();
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
    if (!confirm('ログアウトします。この端末のデータはそのまま残ります。よろしいですか？')) return;
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

      <label class="form-label">メールアドレス</label>
      <input class="form-input" id="sync-email" type="email" autocomplete="username"
             inputmode="email" placeholder="you@example.com"
             value="${window.IRONLOG.helpers.esc((sbLoadSession() || {}).email || '')}" />

      <label class="form-label">パスワード</label>
      <input class="form-input" id="sync-password" type="password" autocomplete="current-password"
             placeholder="8文字以上" />

      <div class="sync-login-msg" id="sync-login-msg"></div>

      <div class="modal-btn-row">
        <button class="btn-cancel"  id="sync-signup">新規登録</button>
        <button class="btn-confirm" id="sync-signin">ログイン</button>
      </div>
      <button class="btn-cancel" id="sync-close" style="width:100%;margin-top:10px">閉じる</button>
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
      overlay.remove();
      updateSyncUI();
      await syncNow({ toast: true });
    } catch (e) {
      msg.textContent = 'できませんでした：' + (e.message || e);
    }
  };

  overlay.querySelector('#sync-signup').addEventListener('click', () => submit('signup'));
  overlay.querySelector('#sync-signin').addEventListener('click', () => submit('signin'));
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
