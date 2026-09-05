// ================================================================
//  IRON LOG — PWA 筋トレ記録アプリ
// ================================================================

// ── IndexedDB for Audio ──────────────────────────────────────────
const AudioDB = (() => {
  let db = null;
  async function init() {
    return new Promise((resolve) => {
      if (db) { resolve(); return; }
      try {
        const req = indexedDB.open('IronLogAudio', 1);
        req.onupgradeneeded = (e) => { e.target.result.createObjectStore('audio'); };
        req.onsuccess  = (e) => { db = e.target.result; resolve(); };
        req.onerror    = () => resolve();
      } catch { resolve(); }
    });
  }
  async function set(key, blob) {
    await init();
    return new Promise((resolve) => {
      if (!db) { resolve(); return; }
      try {
        const tx = db.transaction('audio', 'readwrite');
        tx.objectStore('audio').put(blob, key);
        tx.oncomplete = resolve; tx.onerror = resolve;
      } catch { resolve(); }
    });
  }
  async function get(key) {
    await init();
    return new Promise((resolve) => {
      if (!db) { resolve(null); return; }
      try {
        const tx  = db.transaction('audio', 'readonly');
        const req = tx.objectStore('audio').get(key);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror   = () => resolve(null);
      } catch { resolve(null); }
    });
  }
  async function remove(key) {
    await init();
    return new Promise((resolve) => {
      if (!db) { resolve(); return; }
      try {
        const tx = db.transaction('audio', 'readwrite');
        tx.objectStore('audio').delete(key);
        tx.oncomplete = resolve; tx.onerror = resolve;
      } catch { resolve(); }
    });
  }
  return { init, set, get, delete: remove };
})();

// ── Storage helpers ──────────────────────────────────────────────
const DB = {
  get(key, fallback = null) {
    try {
      const v = localStorage.getItem(key);
      return v !== null ? JSON.parse(v) : fallback;
    } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
  }
};

// ── State ────────────────────────────────────────────────────────
let exercises = DB.get('exercises', [
  { id: 1, name: 'ベンチプレス', weight: 60,  targetSets: 3, presetWeights: [60] },
  { id: 2, name: 'スクワット',   weight: 80,  targetSets: 3, presetWeights: [80] },
  { id: 3, name: 'デッドリフト', weight: 100, targetSets: 3, presetWeights: [100] },
]);
// マイグレーション: 旧データに新フィールドを付与
exercises = exercises.map(ex => ({
  targetSets: 3,
  presetWeights: ex.presetWeights || [ex.weight],
  restSec: null,        // null = 共通のレスト時間を使う
  bodyweight: false,    // 自重を加算するか（懸垂・腕立てなど）
  bwRatio: 100,         // 体重にかける割合(%)
  ...ex
}));

// ── ログのデータ構造（v3）──────────────────────────────────────
//   logs:       [{ id, date:'YYYY-MM-DD', time:'HH:MM', entries:[...], total }]
//   entries:    [{ exId, name, sets, total, setList:[{time,weight}] }]
//   cardioLogs: [{ id, date:'YYYY-MM-DD', time:'HH:MM', mode, type, ... }]
//
//   ・1日に何件でも残せる（同じ日付の記録を消さない）
//   ・累計重量は保存しない。毎回 logs から計算する（二重加算を防ぐため）
let logs       = sortByDate(migrateLogs(DB.get('logs', [])));
let cardioLogs = sortByDate(migrateCardio(DB.get('cardioLogs', [])));
let currentTab = 'workout';
let isSortMode = false;

// 旧形式（日本語の日付文字列）から読み込んだ場合はここで新形式に置き換える
DB.set('logs', logs);
DB.set('cardioLogs', cardioLogs);

// session: { [exId]: { sets:[{time,weight}], open, timer, undoPending } }
let session = {};
// 記録を始めた日付。日付をまたいでも「始めた日」の記録として保存するために持つ
let sessionMeta = DB.get('sessionMeta_v1', {});
// startDate = 記録を始めた日（変わらない） / date = 保存先として選んだ日
// 旧データは date しか持っていないので、それを開始日として引き継ぐ
if (sessionMeta.date && !sessionMeta.startDate) sessionMeta.startDate = sessionMeta.date;

// ── 設定（体重・レストタイマーの既定値） ──────────────────────────
//   種目ごとの上書きは exercise 側（restSec / bodyweight / bwRatio）が持つ。
//   ここは全種目に共通のデフォルトだけを持つ。
let settings = Object.assign(
  { bodyWeight: 0, defaultRestSec: 90, customRestSec: null },
  DB.get('settings_v1', {})
);
function saveSettings() { DB.set('settings_v1', settings); }

function initSession() {
  const saved = DB.get('session_v2', {});
  session = saved;
  // 実行中タイマーを復元
  Object.keys(session).forEach(id => {
    const exId = +id;
    const t = session[exId]?.timer;
    if (t?.running && t.startEpoch) {
      const elapsed = Math.floor((Date.now() - t.startEpoch) / 1000);
      if (t.mode === 'countdown') {
        t.cur = Math.max(0, t.preset - elapsed);
        if (t.cur <= 0) { t.running = false; return; }
      } else {
        t.cur = elapsed;
      }
      restoreTimerInterval(exId);
    }
  });
}
initSession();

function saveSession() { DB.set('session_v2', session); }

// HIIT State
let hiitState = {
  status: 'idle', // idle | countdown | running | paused | finished
  phase: 'work',
  timeLeft: 20,
  currentSet: 1,
  totalSets: 8,
  timerId: null,
  countdownLeft: 3
};
let hiitSettings    = DB.get('hiitSettings',    { countdownMode: false });
let audioSettings   = DB.get('audioSettings',   { work: 'beep', rest: 'beep', finish: 'beep' });
let audioUploadNames= DB.get('audioUploadNames',{ work: '', rest: '', finish: '' });
let showAudioSettings = false;
let hiitCountdownTimer = null;

// Cardio State
let cardioMode    = DB.get('cardioMode', 'simple');
let cardioSession = { type: 'run', distance: '', time: '', speed: '', sprintDist: 100, sprintCount: '', notes: '' };

// ── Web Audio API ─────────────────────────────────────────────────
let audioCtx;
function initAudio() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume();
}

function playBeep(type) {
  if (!audioCtx) return;
  const osc  = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.connect(gain); gain.connect(audioCtx.destination);
  if (type === 'work') {
    osc.type = 'square'; osc.frequency.setValueAtTime(880, audioCtx.currentTime);
    gain.gain.setValueAtTime(0.1, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.6);
    osc.start(audioCtx.currentTime); osc.stop(audioCtx.currentTime + 0.6);
  } else if (type === 'rest') {
    osc.type = 'square'; osc.frequency.setValueAtTime(440, audioCtx.currentTime);
    gain.gain.setValueAtTime(0.1, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.4);
    osc.start(audioCtx.currentTime); osc.stop(audioCtx.currentTime + 0.4);
  } else if (type === 'finish') {
    osc.type = 'square'; osc.frequency.setValueAtTime(1046.5, audioCtx.currentTime);
    gain.gain.setValueAtTime(0.1, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 1.0);
    osc.start(audioCtx.currentTime); osc.stop(audioCtx.currentTime + 1.0);
  }
}

async function playAudio(type) {
  const setting = audioSettings[type] || 'beep';
  if (setting === 'silent') return;
  if (setting === 'beep') { playBeep(type); return; }
  if (setting === 'custom') {
    try {
      const blob = await AudioDB.get(`audio_${type}`);
      if (blob) {
        const url   = URL.createObjectURL(blob);
        const audio = new Audio(url);
        audio.play().catch(() => playBeep(type));
        audio.onended = () => URL.revokeObjectURL(url);
        return;
      }
    } catch {}
    playBeep(type);
  }
}

// ── Utility ──────────────────────────────────────────────────────
const WDAY = ['日','月','火','水','木','金','土'];

function pad2(n) { return String(n).padStart(2, '0'); }
function toISODate(d) { return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`; }
function todayISO() { return toISODate(new Date()); }
function todayStr() { return jpDate(todayISO()); }

// 'YYYY-MM-DD' → '2026年8月5日'
function jpDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
  return m ? `${+m[1]}年${+m[2]}月${+m[3]}日` : (iso || '');
}
function jpDateShort(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
  return m ? `${+m[2]}/${+m[3]}` : (iso || '');
}
function isoWeekday(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
  return m ? WDAY[new Date(+m[1], +m[2]-1, +m[3]).getDay()] : '';
}
// '2026年8月5日' → '2026-08-05'（旧データの読み替え用）
function parseJPDate(s) {
  const m = /(\d{4})年(\d{1,2})月(\d{1,2})日/.exec(s || '');
  return m ? `${m[1]}-${pad2(m[2])}-${pad2(m[3])}` : null;
}

function nowHHMM() {
  const d = new Date();
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
function formatSec(s) {
  const m  = String(Math.floor(s/60)).padStart(2,'0');
  const sc = String(s%60).padStart(2,'0');
  return `${m}:${sc}`;
}
function uid() { return Date.now() + Math.random(); }
// ログ用のID。端末をまたいでも衝突しないように乱数を混ぜた文字列にする
function newId() { return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8); }

// HTMLに埋め込む前に必ず通す（種目名やメモに " や < が入ると表示が壊れるため）
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g,
    c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}

// 新しい順（日付 → 時刻）に並べる
function sortByDate(list) {
  return [...list].sort((a, b) =>
    (b.date || '').localeCompare(a.date || '') || (b.time || '').localeCompare(a.time || ''));
}

// 累計重量は保存値ではなく毎回ログから計算する
function totalWeight() { return logs.reduce((s, l) => s + (l.total || 0), 0); }
function trainedDays() { return new Set(logs.map(l => l.date)).size; }

// ── 旧データの移行 ───────────────────────────────────────────────
function migrateLogs(list) {
  return (list || []).map(l => {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(l.date || '') ? l.date
               : (parseJPDate(l.date) || todayISO());
    const entries = (l.entries || []).map(e => {
      const sets  = e.sets || 0;
      const total = e.total ?? (e.weight || 0) * sets;
      return {
        exId:    e.exId ?? null,
        name:    e.name,
        sets,
        total,
        setList: e.setList || null,   // 旧データはセットごとの内訳を持っていない
      };
    });
    return {
      id:      l.id || newId(),
      date,
      time:    l.time || '',
      entries,
      total:   l.total ?? entries.reduce((s, e) => s + e.total, 0),
    };
  });
}

function migrateCardio(list) {
  return (list || []).map(c => {
    const o = { ...c };
    // 旧データの time は「分」だった。記録時刻(HH:MM)と紛らわしいので minutes に移す
    if (o.minutes === undefined && o.time !== undefined && !/^\d{1,2}:\d{2}$/.test(String(o.time))) {
      o.minutes = o.time;
    }
    o.id   = c.id || newId();
    o.date = /^\d{4}-\d{2}-\d{2}$/.test(c.date || '') ? c.date : (parseJPDate(c.date) || todayISO());
    o.time = /^\d{1,2}:\d{2}$/.test(String(c.time || '')) ? c.time : '';
    return o;
  });
}

function saveExercises()  { DB.set('exercises', exercises); notifySaved('exercises'); }
function saveLogs()       { logs = sortByDate(logs); DB.set('logs', logs); notifySaved('logs'); }
function saveCardioLogs() { cardioLogs = sortByDate(cardioLogs); DB.set('cardioLogs', cardioLogs); notifySaved('cardio'); }
function saveSessionMeta(){ DB.set('sessionMeta_v1', sessionMeta); }

// sync.js が読み込まれていれば、保存のたびに同期を予約してもらう
function notifySaved(kind) {
  try { if (window.onIronLogSaved) window.onIronLogSaved(kind); } catch {}
}

// ── 自重を含む実効重量 ───────────────────────────────────────────
//   自重ONの種目は「体重×割合 ＋ 追加のオモリ」が1セットで扱う重量になる。
//   記録時の値をセットごとに保存するので、あとで体重を変えても過去の記録は動かない。
function bodyweightPart(ex) {
  if (!ex || !ex.bodyweight) return 0;
  return Math.round((settings.bodyWeight || 0) * ((ex.bwRatio ?? 100) / 100) * 10) / 10;
}
function effectiveWeight(ex) {
  if (!ex) return 0;
  return Math.round((bodyweightPart(ex) + (ex.weight || 0)) * 10) / 10;
}
function weightBreakdown(ex) {
  if (!ex || !ex.bodyweight) return '';
  const add = ex.weight || 0;
  return `自重${settings.bodyWeight || 0}kg×${ex.bwRatio ?? 100}%${add ? ` ＋ ${add}kg` : ''}`;
}

// ── レスト時間 ───────────────────────────────────────────────────
const REST_PRESETS = [60, 90, 120, 180];
function restSecFor(ex) {
  return (ex && typeof ex.restSec === 'number') ? ex.restSec : (settings.defaultRestSec || 90);
}
function clampRest(v) { return Math.max(5, Math.min(3600, Math.round(+v || 0))); }

// 1件の種目の「60kg × 3set」表示。セットごとに重量が違う場合は範囲で出す
function entryWeightLabel(e) {
  const ws = (e.setList || []).map(s => s.weight).filter(w => typeof w === 'number');
  if (!ws.length) {
    const w = e.sets ? Math.round((e.total / e.sets) * 10) / 10 : 0;
    return `${w}kg`;
  }
  const min = Math.min(...ws), max = Math.max(...ws);
  return min === max ? `${min}kg` : `${min}〜${max}kg`;
}

// ── Toast ────────────────────────────────────────────────────────
let toastTimer;
function showToast(msg) {
  let el = document.querySelector('.toast');
  if (el) el.remove();
  el = document.createElement('div');
  el.className  = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.remove(), 2800);
}

// ── Gauge ────────────────────────────────────────────────────────
function renderGauge(count, target) {
  const segs  = Math.max(1, target);
  const over  = count > target;
  let color;
  if (over)                        color = 'var(--red)';
  else if (count >= target)        color = 'var(--green)';
  else if (count / target >= 0.5)  color = 'var(--accent2)';
  else                             color = 'var(--cyan)';

  let html = `<div class="gauge-wrap">`;
  for (let i = 0; i < segs; i++) {
    const filled = i < count;
    html += `<div class="gauge-seg${filled ? ' filled' : ''}"${filled && color ? ` style="background:${color}"` : ''}></div>`;
  }
  html += `</div>`;
  if (over) html += `<span class="gauge-fire">🔥</span>`;
  return html;
}

// ================================================================
//  RENDER ENGINE
// ================================================================
function render() {
  document.getElementById('app').innerHTML = `
    ${renderHeader()}
    ${renderTabBar()}
    <div class="content" id="content">
      ${currentTab === 'workout' ? renderWorkout()
        : currentTab === 'hiit'   ? renderHiit()
        : currentTab === 'cardio' ? renderCardio()
        : currentTab === 'log'    ? renderLog()
        :                           renderStats()}
    </div>
  `;
  bindEvents();
  // sync.js が読み込まれていれば同期カードを差し込んでもらう
  try { if (window.onIronLogRender) window.onIronLogRender(); } catch {}
}

// ── Header ──────────────────────────────────────────────────────
function renderHeader() {
  return `
    <header class="app-header">
      <div><div class="app-title">IRON LOG</div></div>
      <div class="app-date">${todayStr()}</div>
    </header>
  `;
}

// ── Tab bar ─────────────────────────────────────────────────────
function renderTabBar() {
  const tabs = [
    ['workout', '🏋️', 'トレーニング'],
    ['hiit',    '🚴', 'ヒート'],
    ['cardio',  '🏃', '有酸素'],
    ['log',     '📅', 'ログ'],
    ['stats',   '📊', '統計'],
  ];
  return `<nav class="tab-bar">
    ${tabs.map(([id, icon, label]) =>
      `<button class="tab-btn${currentTab===id?' active':''}" data-tab="${id}">
        <span class="tab-icon">${icon}</span>
        <span class="tab-label">${label}</span>
      </button>`
    ).join('')}
  </nav>`;
}

// ── Workout tab ──────────────────────────────────────────────────
function renderPreviewCard(entries) {
  if (entries.length === 0) return '';
  const date = sessionMeta.date || todayISO();
  const nth  = logs.filter(l => l.date === date).length + 1;
  return `
    <div class="save-preview-card">
      <div class="save-preview-title">
        📋 今回の記録プレビュー
        <span class="save-preview-date">${jpDate(date)}${nth > 1 ? ` ・${nth}件目` : ''}</span>
      </div>
      ${entries.map(e => `
        <div class="save-preview-row">
          <span class="save-preview-name">${esc(e.name)}</span>
          <span class="save-preview-sets">${e.sets} set</span>
          <span class="save-preview-total">${e.total.toLocaleString()} kg</span>
        </div>
      `).join('')}
    </div>`;
}

function renderWorkout() {
  const previewEntries = buildPreviewEntries();
  const previewHtml = renderPreviewCard(previewEntries);

  // 日付をまたいで記録が残っている場合。どちらの日付で保存するか選べるようにする
  const mdw       = iso => `${jpDate(iso).replace(/^\d+年/, '')}(${isoWeekday(iso)})`;
  const startDate = sessionMeta.startDate || sessionMeta.date;
  const saveDate  = sessionMeta.date || todayISO();
  const today     = todayISO();

  const carryOver = (previewEntries.length > 0 && startDate && startDate !== today)
    ? `<div class="carryover-note">
         ⚠️ この記録は <strong>${mdw(startDate)}</strong> に始めたものです。どちらの日付で保存しますか？
         <div class="carryover-choice">
           <button class="btn-carryover${saveDate === startDate ? ' selected' : ''}" data-carryover-date="${startDate}">
             ${mdw(startDate)}<span class="btn-carryover-sub">始めた日</span>
           </button>
           <button class="btn-carryover${saveDate === today ? ' selected' : ''}" data-carryover-date="${today}">
             ${mdw(today)}<span class="btn-carryover-sub">今日</span>
           </button>
         </div>
       </div>`
    : '';

  return `
    ${carryOver}
    <div style="display: flex; gap: 10px; margin-bottom: 14px;">
      <button class="btn-add-exercise" id="btn-add-ex" style="margin-bottom: 0; flex: 1;">＋ 種目を追加</button>
      <button class="btn-sort-toggle${isSortMode ? ' active' : ''}" id="btn-toggle-sort">
        ${isSortMode ? '並び替え: ON' : '並び替え: OFF'}
      </button>
    </div>
    <div id="ex-list">
      ${exercises.map((ex, idx) => renderExCard(ex, idx)).join('')}
    </div>
    ${previewHtml}
    <button class="btn-save-log" id="btn-save-log">
      💾 ${saveDate === today ? '今日' : mdw(saveDate)}のログを保存
    </button>
  `;
}

function buildPreviewEntries() {
  return exercises
    .map(ex => {
      const s = session[ex.id];
      if (!s || s.sets.length === 0) return null;
      const setList = s.sets.map(st => ({ time: st.time, weight: st.weight ?? effectiveWeight(ex) }));
      const total   = setList.reduce((sum, st) => sum + st.weight, 0);
      return { exId: ex.id, name: ex.name, sets: setList.length, total, setList };
    })
    .filter(Boolean);
}

function renderExCard(ex, index) {
  const sess     = session[ex.id] || { sets: [] };
  const setCount = sess.sets.length;
  const target   = ex.targetSets || 3;

  return `
  <div class="ex-card" data-exid="${ex.id}">
    <div class="ex-card-header">
      <div class="ex-info">
        <div class="ex-name">${esc(ex.name)}</div>
        <div class="ex-header-bottom">
          <div class="ex-weight">
            ${effectiveWeight(ex)} kg
            ${ex.bodyweight ? `<span class="ex-weight-sub">${esc(weightBreakdown(ex))}</span>` : ''}
          </div>
          <div class="ex-gauge-wrap">${renderGauge(setCount, target)}</div>
        </div>
      </div>
      <div class="ex-card-actions">
        ${isSortMode ? `
          <button class="btn-icon" data-move-up="${ex.id}" ${index === 0 ? 'disabled' : ''}>↑</button>
          <button class="btn-icon" data-move-down="${ex.id}" ${index === exercises.length - 1 ? 'disabled' : ''}>↓</button>
        ` : ''}
        <button class="btn-icon" data-edit="${ex.id}">✏️</button>
        <button class="btn-icon danger" data-delete="${ex.id}">🗑</button>
        <button class="btn-icon" data-toggle="${ex.id}">${sess.open ? '▲' : '▼'}</button>
      </div>
    </div>

    ${sess.open ? `
    <div class="ex-card-body">
      <div class="set-counter-section">
        <div class="section-label">セット記録</div>
        <button class="btn-set-tap" data-set-tap="${ex.id}">
          <div class="set-count-display">${setCount}</div>
          <div class="set-count-label">SET COMPLETED</div>
        </button>

        ${setCount > 0 ? `
        <div class="set-history">
          ${sess.sets.map((s, i) => `
            <div class="set-history-row">
              <span class="set-history-num">Set ${i+1}</span>
              <span class="set-history-time">${s.time}</span>
              <span class="set-history-weight">${s.weight ?? effectiveWeight(ex)}kg</span>
              ${i === setCount-1 ? (sess.undoPending
                ? `<button class="btn-undo-confirm" data-undo="${ex.id}" data-confirm="true">本当に？</button>`
                : `<button class="btn-undo-single" data-undo="${ex.id}">↩ 取消</button>`
              ) : ''}
            </div>
          `).join('')}
        </div>
        ` : ''}
      </div>

      <div class="rest-timer-section">
        <div class="section-label">レストタイマー（補助）</div>
        ${renderTimer(ex.id, sess)}
      </div>
    </div>
    ` : ''}
  </div>
  `;
}

// ── Timer renderer ───────────────────────────────────────────────
//   秒数は種目に保存される（ex.restSec）。指定がなければ共通の既定値を使う。
//   計測中に秒数を変えても止まらない。経過時間はそのままで残りだけが増減する。
function renderTimer(exId, sess) {
  const ex = exercises.find(x => x.id === exId);
  const t  = sess.timer || { mode: 'countdown', preset: restSecFor(ex), cur: restSecFor(ex), running: false };

  let displaySec;
  if (t.running && t.startEpoch) {
    const elapsed = Math.floor((Date.now() - t.startEpoch) / 1000);
    displaySec = t.mode === 'countdown' ? Math.max(0, t.preset - elapsed) : elapsed;
  } else {
    displaySec = t.mode === 'countdown' ? (t.cur ?? t.preset) : (t.cur ?? 0);
  }

  const cls = !t.running ? 'idle'
    : t.mode === 'countdown' ? (displaySec <= 10 ? 'warning' : 'running-countdown')
    : 'running-stopwatch';

  const activeSec = t.preset ?? restSecFor(ex);
  const isCustom  = !REST_PRESETS.includes(activeSec);
  const perEx     = ex && typeof ex.restSec === 'number';

  return `
    <div class="timer-mode-toggle">
      <button class="btn-mode${t.mode==='countdown'?' active-countdown':''}" data-timer-mode="${exId}" data-mode="countdown">
        ⏳ カウントダウン
      </button>
      <button class="btn-mode${t.mode==='stopwatch'?' active-stopwatch':''}" data-timer-mode="${exId}" data-mode="stopwatch">
        ⏱ ストップウォッチ
      </button>
    </div>

    ${t.mode==='countdown' ? `
    <div class="timer-presets">
      ${REST_PRESETS.map(p => `
        <button class="btn-preset${activeSec===p?' selected':''}" data-timer-preset="${exId}" data-sec="${p}">
          ${p}秒
        </button>
      `).join('')}
      <button class="btn-preset${isCustom?' selected':''}" data-timer-custom-open="${exId}">
        ${isCustom ? `${activeSec}秒 ✏️` : 'その他'}
      </button>
    </div>
    <div class="timer-rest-note">
      ${perEx
        ? `この種目は <strong>${ex.restSec}秒</strong> で保存済み（共通は${settings.defaultRestSec}秒）
           <button class="btn-rest-clear" data-timer-rest-clear="${exId}">共通に戻す</button>`
        : `共通の <strong>${settings.defaultRestSec}秒</strong> を使用中。秒数を選ぶとこの種目に保存されます`}
    </div>
    ` : ''}

    <div class="timer-display ${cls}" id="timer-disp-${exId}">
      ${formatSec(displaySec)}
    </div>

    ${t.running && t.mode==='countdown' ? `
    <div class="timer-adjust-row">
      <button class="btn-timer-adjust" data-timer-adjust="${exId}" data-delta="-15">− 15秒</button>
      <button class="btn-timer-adjust" data-timer-adjust="${exId}" data-delta="15">＋ 15秒</button>
    </div>
    ` : ''}

    <div class="timer-ctrl-row">
      ${t.running ? `
        <button class="btn-timer-stop" data-timer-stop="${exId}">⏹ ストップ</button>
        <button class="btn-timer-reset" data-timer-reset="${exId}">リセット</button>
      ` : `
        <button class="btn-timer-start${t.mode==='stopwatch'?' cyan':''}" data-timer-start="${exId}">
          ▶ スタート
        </button>
        ${t.mode==='countdown' ? `<button class="btn-timer-reset" data-timer-reset="${exId}">リセット</button>` : ''}
      `}
    </div>
  `;
}

// ── HIIT tab ─────────────────────────────────────────────────────
function renderHiit() {
  let phaseText, colorClass, timerDisplay;

  if (hiitState.status === 'countdown') {
    phaseText = 'GET READY'; colorClass = 'hiit-ready'; timerDisplay = hiitState.countdownLeft;
  } else if (hiitState.status === 'finished') {
    phaseText = 'COMPLETED'; colorClass = 'hiit-finish'; timerDisplay = 0;
  } else if (hiitState.phase === 'work') {
    phaseText = 'WORK (20s)'; colorClass = 'hiit-work'; timerDisplay = hiitState.timeLeft;
  } else {
    phaseText = 'REST (10s)'; colorClass = 'hiit-rest'; timerDisplay = hiitState.timeLeft;
  }

  return `
    <div class="hiit-container">
      <div class="hiit-header">HIIT BIKE</div>
      <div class="hiit-set" id="hiit-set-disp">Set: ${hiitState.currentSet} / ${hiitState.totalSets}</div>
      <div class="hiit-phase ${colorClass}" id="hiit-phase-disp">${phaseText}</div>
      <div class="hiit-timer ${colorClass}" id="hiit-timer-disp">${timerDisplay}</div>

      <div class="timer-ctrl-row" style="margin-top: 30px;">
        ${hiitState.status === 'idle' || hiitState.status === 'finished' ? `
          <button class="btn-timer-start" id="btn-hiit-start">▶ スタート</button>
        ` : hiitState.status === 'countdown' ? `
          <button class="btn-timer-stop" id="btn-hiit-cancel-cd">✕ キャンセル</button>
        ` : hiitState.status === 'running' ? `
          <button class="btn-timer-stop" id="btn-hiit-pause">⏸ ストップ</button>
        ` : `
          <button class="btn-timer-start" id="btn-hiit-resume">▶ リスタート</button>
        `}
        ${hiitState.status !== 'countdown' ? `
          <button class="btn-timer-reset" id="btn-hiit-reset">リセット</button>
        ` : ''}
      </div>

      <div class="hiit-settings-section">
        <div class="hiit-setting-row">
          <span class="hiit-setting-label">3秒カウントダウン</span>
          <button class="hiit-toggle-btn${hiitSettings.countdownMode ? ' active' : ''}" id="btn-hiit-countdown-toggle">
            ${hiitSettings.countdownMode ? 'ON' : 'OFF'}
          </button>
        </div>
        <div class="hiit-setting-row">
          <span class="hiit-setting-label">音声設定</span>
          <button class="hiit-toggle-btn${showAudioSettings ? ' active' : ''}" id="btn-audio-settings-toggle">
            ${showAudioSettings ? '閉じる' : '設定'}
          </button>
        </div>
        ${showAudioSettings ? renderAudioSettings() : ''}
      </div>
    </div>
  `;
}

function renderAudioSettings() {
  const types = [
    { key: 'work',   label: 'スタート音' },
    { key: 'rest',   label: '休憩音' },
    { key: 'finish', label: '完了音' },
  ];
  return `
    <div class="audio-settings-panel">
      ${types.map(({ key, label }) => `
        <div class="audio-setting-row">
          <span class="audio-setting-label">${label}</span>
          <div class="audio-options">
            <button class="audio-opt-btn${audioSettings[key]==='beep'?' selected':''}"   data-audio-type="${key}" data-audio-opt="beep">ビープ</button>
            <button class="audio-opt-btn${audioSettings[key]==='silent'?' selected':''}" data-audio-type="${key}" data-audio-opt="silent">無音</button>
            <button class="audio-opt-btn${audioSettings[key]==='custom'?' selected':''}" data-audio-type="${key}" data-audio-opt="custom">
              ${audioUploadNames[key] ? '✓ ' + esc(audioUploadNames[key]) : 'MP3'}
            </button>
          </div>
          ${audioSettings[key] === 'custom' ? `
            <label class="audio-upload-label">
              📁 MP3を選択
              <input type="file" accept="audio/mp3,audio/*" class="audio-file-input" data-audio-upload="${key}" style="display:none" />
            </label>
          ` : ''}
        </div>
      `).join('')}
    </div>
  `;
}

function updateHiitDisplay() {
  const timerEl = document.getElementById('hiit-timer-disp');
  if (!timerEl) return;
  const phaseEl = document.getElementById('hiit-phase-disp');
  const setEl   = document.getElementById('hiit-set-disp');

  let phaseText, colorClass, timerVal;
  if (hiitState.status === 'countdown') {
    phaseText = 'GET READY'; colorClass = 'hiit-ready'; timerVal = hiitState.countdownLeft;
  } else if (hiitState.status === 'finished') {
    phaseText = 'COMPLETED'; colorClass = 'hiit-finish'; timerVal = 0;
  } else if (hiitState.phase === 'work') {
    phaseText = 'WORK (20s)'; colorClass = 'hiit-work'; timerVal = hiitState.timeLeft;
  } else {
    phaseText = 'REST (10s)'; colorClass = 'hiit-rest'; timerVal = hiitState.timeLeft;
  }

  timerEl.textContent = timerVal;
  timerEl.className   = `hiit-timer ${colorClass}`;
  if (setEl)   setEl.textContent  = `Set: ${hiitState.currentSet} / ${hiitState.totalSets}`;
  if (phaseEl) { phaseEl.textContent = phaseText; phaseEl.className = `hiit-phase ${colorClass}`; }
}

function startHiitWithCountdown() {
  initAudio();
  if (hiitState.status === 'finished') {
    hiitState.currentSet = 1; hiitState.phase = 'work'; hiitState.timeLeft = 20;
  }
  if (hiitSettings.countdownMode) {
    hiitState.status = 'countdown'; hiitState.countdownLeft = 3;
    render();
    hiitCountdownTimer = setInterval(() => {
      hiitState.countdownLeft--;
      if (hiitState.countdownLeft <= 0) {
        clearInterval(hiitCountdownTimer); hiitCountdownTimer = null;
        startHiitActual();
      } else { updateHiitDisplay(); }
    }, 1000);
  } else {
    startHiitActual();
  }
}

function startHiitActual() {
  hiitState.status = 'running';
  playAudio('work');
  hiitState.timerId = setInterval(hiitTick, 1000);
  render();
}

function hiitTick() {
  hiitState.timeLeft--;
  if (hiitState.timeLeft <= 0) {
    if (hiitState.phase === 'work') {
      hiitState.phase = 'rest'; hiitState.timeLeft = 10;
      playAudio('rest');
    } else {
      if (hiitState.currentSet >= hiitState.totalSets) {
        hiitState.status = 'finished'; hiitState.timeLeft = 0;
        playAudio('finish');
        clearInterval(hiitState.timerId); render(); return;
      } else {
        hiitState.currentSet++; hiitState.phase = 'work'; hiitState.timeLeft = 20;
        playAudio('work');
      }
    }
  }
  updateHiitDisplay();
}

// ── Cardio tab ───────────────────────────────────────────────────
function renderCardio() {
  const todayCardio = cardioLogs.filter(l => l.date === todayISO());
  return `
    <div class="cardio-container">
      <div class="cardio-mode-toggle">
        <button class="cardio-mode-btn${cardioMode==='simple'?' active':''}" data-cardio-mode="simple">シンプル</button>
        <button class="cardio-mode-btn${cardioMode==='calc'?  ' active':''}" data-cardio-mode="calc">算出モード</button>
        <button class="cardio-mode-btn${cardioMode==='sprint'?' active':''}" data-cardio-mode="sprint">ダッシュ</button>
      </div>

      ${cardioMode === 'simple' ? renderCardioSimple()
        : cardioMode === 'calc'  ? renderCardioCalc()
        : renderCardioSprint()}

      <button class="btn-save-cardio" id="btn-save-cardio">💾 有酸素を保存</button>

      ${todayCardio.length > 0 ? `
        <div class="cardio-log-section">
          <div class="section-label" style="margin-top:16px">本日の有酸素記録</div>
          ${todayCardio.map(l => renderCardioLogItem(l, true)).join('')}
        </div>
      ` : ''}
    </div>
  `;
}

function cardioTypeRow() {
  return `
    <div class="cardio-type-row">
      ${['run','walk','bike'].map(t => `
        <button class="cardio-type-btn${cardioSession.type===t?' active':''}" data-cardio-type="${t}">
          ${t==='run'?'🏃 ランニング':t==='walk'?'🚶 ウォーキング':'🚴 バイク'}
        </button>
      `).join('')}
    </div>`;
}

function renderCardioSimple() {
  return `
    <div class="cardio-form">
      ${cardioTypeRow()}
      <label class="form-label">距離 (km)</label>
      <input class="form-input" type="number" step="0.01" min="0" placeholder="例: 5.0" id="cardio-distance" value="${cardioSession.distance}" />
      <label class="form-label">時間 (分)</label>
      <input class="form-input" type="number" step="1"    min="0" placeholder="例: 30"  id="cardio-time"     value="${cardioSession.time}" />
      <label class="form-label">メモ</label>
      <input class="form-input" type="text" placeholder="任意" id="cardio-notes" value="${esc(cardioSession.notes)}" />
    </div>`;
}

function renderCardioCalc() {
  return `
    <div class="cardio-form">
      ${cardioTypeRow()}
      <div class="cardio-calc-note">💡 2つ入力すると残りを自動算出します</div>
      <label class="form-label">距離 (km)</label>
      <input class="form-input" type="number" step="0.01" min="0" placeholder="例: 5.0"  id="cardio-distance" value="${cardioSession.distance}" />
      <label class="form-label">時間 (分)</label>
      <input class="form-input" type="number" step="1"    min="0" placeholder="例: 30"   id="cardio-time"     value="${cardioSession.time}" />
      <label class="form-label">速度 (km/h)</label>
      <input class="form-input" type="number" step="0.1"  min="0" placeholder="例: 10.0" id="cardio-speed"    value="${cardioSession.speed}" />
      <label class="form-label">メモ</label>
      <input class="form-input" type="text" placeholder="任意" id="cardio-notes" value="${esc(cardioSession.notes)}" />
    </div>`;
}

function renderCardioSprint() {
  return `
    <div class="cardio-form">
      <label class="form-label">距離 (m)</label>
      <div class="sprint-dist-row">
        ${[50,100,200,400].map(d => `
          <button class="btn-preset${cardioSession.sprintDist==d?' selected':''}" data-sprint-dist="${d}">${d}m</button>
        `).join('')}
      </div>
      <input class="form-input" type="number" step="1" min="1" placeholder="カスタム (m)"
        id="cardio-sprint-dist" value="${cardioSession.sprintDist}" style="margin-top:8px" />
      <label class="form-label">本数</label>
      <input class="form-input" type="number" step="1" min="1" placeholder="例: 5"
        id="cardio-sprint-count" value="${cardioSession.sprintCount}" />
      <label class="form-label">メモ</label>
      <input class="form-input" type="text" placeholder="任意" id="cardio-notes" value="${esc(cardioSession.notes)}" />
    </div>`;
}

function cardioDetail(l) {
  if (l.mode === 'sprint') return `${l.sprintDist}m × ${l.sprintCount}本`;
  const parts = [];
  if (l.distance) parts.push(`${l.distance}km`);
  if (l.minutes)  parts.push(`${l.minutes}分`);
  if (l.speed)    parts.push(`${l.speed}km/h`);
  return parts.join(' / ');
}

function renderCardioLogItem(l, withActions = false) {
  const typeLabel = l.type === 'run' ? '🏃' : l.type === 'walk' ? '🚶' : '🚴';
  return `
    <div class="cardio-log-item">
      <span class="cardio-log-type">${typeLabel}</span>
      <span class="cardio-log-detail">${esc(cardioDetail(l))}</span>
      ${l.notes ? `<span class="cardio-log-notes">${esc(l.notes)}</span>` : ''}
      ${withActions ? `
        <button class="btn-icon" data-cardio-edit="${l.id}" title="日付・時刻を変更">✏️</button>
        <button class="btn-icon danger" data-cardio-del="${l.id}" title="削除">🗑</button>
      ` : ''}
    </div>`;
}

function calcCardioAuto() {
  if (cardioMode !== 'calc') return;
  const d = parseFloat(document.getElementById('cardio-distance')?.value);
  const t = parseFloat(document.getElementById('cardio-time')?.value);
  const s = parseFloat(document.getElementById('cardio-speed')?.value);
  const ok = (v) => !isNaN(v) && v > 0;
  if (ok(d) && ok(t) && !ok(s)) {
    const spd = d / (t / 60);
    const el  = document.getElementById('cardio-speed');
    if (el) el.value = spd.toFixed(1);
  } else if (ok(d) && ok(s) && !ok(t)) {
    const tm = (d / s) * 60;
    const el = document.getElementById('cardio-time');
    if (el) el.value = Math.round(tm);
  } else if (ok(t) && ok(s) && !ok(d)) {
    const dist = s * (t / 60);
    const el   = document.getElementById('cardio-distance');
    if (el) el.value = dist.toFixed(2);
  }
}

// ── Log tab ──────────────────────────────────────────────────────
//   日付ごとにまとめ、その中に「筋トレ何件」「有酸素何件」を並べる。
//   1件ずつ日付・時刻の変更と削除ができる。
function renderLog() {
  if (logs.length === 0 && cardioLogs.length === 0) {
    return `<div class="empty">まだログがありません</div>`;
  }

  // logs は新しい順なので、1日の中は逆順にして「1回目」が本当に最初になるようにする
  const days = {};
  const day  = d => (days[d] = days[d] || { workouts: [], cardio: [] });
  [...logs].reverse().forEach(l => day(l.date).workouts.push(l));
  [...cardioLogs].reverse().forEach(c => day(c.date).cardio.push(c));
  Object.values(days).forEach(d => {
    d.workouts.sort((a, b) => (a.time || '').localeCompare(b.time || ''));
    d.cardio.sort((a, b) => (a.time || '').localeCompare(b.time || ''));
  });

  return Object.keys(days).sort().reverse().map(date => {
    const d        = days[date];
    const dayTotal = d.workouts.reduce((s, l) => s + (l.total || 0), 0);
    return `
    <div class="log-card">
      <div class="log-date">
        ${jpDate(date)}<span class="log-weekday">(${isoWeekday(date)})</span>
        ${d.workouts.length > 1 ? `<span class="log-count-badge">${d.workouts.length}回</span>` : ''}
      </div>
      ${d.workouts.map((log, i) => renderLogSession(log, i, d.workouts.length)).join('')}
      ${d.cardio.map(c => renderCardioLogItem(c, true)).join('')}
      ${dayTotal > 0 ? `<div class="log-total">この日の総重量：<strong>${dayTotal.toLocaleString()} kg</strong></div>` : ''}
    </div>`;
  }).join('');
}

function renderLogSession(log, index, count) {
  return `
    <div class="log-session">
      <div class="log-session-head">
        <span class="log-session-time">🕐 ${log.time || '時刻なし'}</span>
        ${count > 1 ? `<span class="log-session-nth">${index + 1}回目</span>` : ''}
        <span class="log-session-total">${log.total.toLocaleString()} kg</span>
        <button class="btn-icon" data-log-edit="${log.id}" title="日付・時刻を変更">✏️</button>
        <button class="btn-icon danger" data-log-del="${log.id}" title="削除">🗑</button>
      </div>
      ${log.entries.map(e => `
        <div class="log-entry">
          <span class="log-entry-name">${esc(e.name)}</span>
          <span class="log-entry-detail">${entryWeightLabel(e)} × ${e.sets}set</span>
          <span class="log-entry-sub">${(e.total ?? 0).toLocaleString()}kg</span>
        </div>
      `).join('')}
    </div>`;
}

// ── 設定カード（体重・レスト時間の既定値） ───────────────────────
function renderSettingsCard() {
  const isPreset = REST_PRESETS.includes(settings.defaultRestSec);
  const bwCount  = exercises.filter(x => x.bodyweight).length;
  return `
    <div class="transfer-card">
      <div class="transfer-title">⚙️ 設定</div>

      <div class="setting-block">
        <div class="setting-label">体重</div>
        <div class="setting-help">
          懸垂・腕立てなど「自重を加算」にした種目の重量計算に使います。
          ${bwCount ? `いま ${bwCount}種目 が自重ONです。` : '種目の編集画面で ON にできます。'}
        </div>
        <div class="setting-input-row">
          <input class="form-input setting-input" id="set-bodyweight" type="number" inputmode="decimal"
                 step="0.1" min="0" max="300" value="${settings.bodyWeight || ''}" placeholder="70" />
          <span class="setting-unit">kg</span>
        </div>
        ${!settings.bodyWeight && bwCount ? `<div class="bw-warn">体重が未設定です。自重ぶんが 0kg で計算されています</div>` : ''}
      </div>

      <div class="setting-block">
        <div class="setting-label">レスト時間の既定値</div>
        <div class="setting-help">
          種目ごとに指定していない場合はこの秒数を使います。
          変えると、いま動いていないタイマーにもすぐ反映されます。
        </div>
        <div class="timer-presets">
          ${REST_PRESETS.map(p => `
            <button class="btn-preset${settings.defaultRestSec===p?' selected':''}" data-default-rest="${p}">${p}秒</button>
          `).join('')}
          <button class="btn-preset${!isPreset?' selected':''}" data-default-rest-custom="1">
            ${!isPreset ? `${settings.defaultRestSec}秒 ✏️` : 'その他'}
          </button>
        </div>
      </div>
    </div>`;
}

// ── Obsidian 書き出しカード ───────────────────────────────────────
function renderObsidianCard() {
  return `
    <div class="transfer-card">
      <div class="transfer-title">🗒 Obsidian に書き出す</div>
      <p class="transfer-desc">
        記録を Markdown ノートとして書き出します。<br>
        iPhone では共有シートが開くので、Obsidian の保管庫（Vault）に保存してください。
      </p>
      <button class="btn-obsidian" data-obsidian="all">
        <span class="transfer-btn-icon">📦</span>一式（サマリー＋日別＋種目別・ZIP）
      </button>
      <button class="btn-obsidian" data-obsidian="daily">
        <span class="transfer-btn-icon">📅</span>日別ノートだけ（ZIP）
      </button>
      <button class="btn-obsidian" data-obsidian="single">
        <span class="transfer-btn-icon">📄</span>1ファイルにまとめる（.md）
      </button>
    </div>`;
}

// ── 複数端末同期カード（中身は sync.js が入れる）─────────────────
function renderSyncCard() {
  return `
    <div class="transfer-card">
      <div class="transfer-title">☁️ 複数端末で同期</div>
      <div id="sync-card-body">
        <p class="transfer-desc">同期機能を読み込めませんでした（sync.js）。</p>
      </div>
    </div>`;
}

// ── Stats tab ────────────────────────────────────────────────────
function renderStats() {
  const total  = totalWeight();
  const days   = trainedDays();
  const avg    = days > 0 ? Math.round(total / days) : 0;
  const recent = logs.slice(0, 8).reverse();
  const maxTotal = recent.length > 0 ? Math.max(...recent.map(l=>l.total)) : 1;

  return `
    <div class="stat-grid">
      <div class="stat-card wide">
        <div class="stat-label">累計扱った総重量</div>
        <div class="stat-value">${total.toLocaleString()} <span class="stat-unit">kg</span></div>
      </div>
      <div class="stat-card">
        <div class="stat-label">記録日数</div>
        <div class="stat-value">${days} <span class="stat-unit">日</span></div>
      </div>
      <div class="stat-card">
        <div class="stat-label">平均 / 日</div>
        <div class="stat-value">${avg.toLocaleString()} <span class="stat-unit">kg</span></div>
      </div>
    </div>

    ${recent.length > 0 ? `
      <div class="stat-card">
        <div class="stat-label" style="margin-bottom:14px">直近セッション 総重量推移</div>
        ${recent.map(log => `
          <div class="bar-row">
            <span class="bar-label">${jpDateShort(log.date)}${log.time ? `<br>${log.time}` : ''}</span>
            <div class="bar-track">
              <div class="bar-fill" style="width:${Math.round((log.total/maxTotal)*100)}%"></div>
            </div>
            <span class="bar-val">${log.total.toLocaleString()}kg</span>
          </div>
        `).join('')}
      </div>
    ` : ''}

    ${renderSettingsCard()}
    ${renderSyncCard()}
    ${renderObsidianCard()}

    <div class="transfer-card">
      <div class="transfer-title">📲 機種変更・データ引き継ぎ</div>
      <p class="transfer-desc">
        全データ（種目・ログ・累計重量）をJSONファイルに書き出します。<br>
        新しいiPhoneで同じアプリを開き、インポートしてください。
      </p>

      <div class="transfer-section-label">STEP 1 — 旧端末でエクスポート</div>
      <button class="btn-export" id="btn-export">
        <span class="transfer-btn-icon">⬆️</span>データをエクスポート（ファイル保存）
      </button>

      <div class="transfer-section-label" style="margin-top:20px">STEP 2 — 新端末でインポート</div>
      <p class="transfer-note">※ 現在のデータはすべて上書きされます</p>
      <label class="btn-import-label" id="btn-import-label">
        <span class="transfer-btn-icon">⬇️</span>データをインポート（ファイル選択）
        <input type="file" id="import-file-input" accept=".json" style="display:none" />
      </label>

      <div class="transfer-section-label" style="margin-top:20px; color:var(--red)">⚠️ データ削除</div>
      <p class="transfer-note">※ 削除したデータは元に戻せません</p>
      <button class="btn-delete-all" id="btn-delete-all">
        <span class="transfer-btn-icon">🗑</span>全データを削除
      </button>
    </div>
  `;
}

// ================================================================
//  TIMER ENGINE (Workout)
// ================================================================
const timerIntervals = {};

function getOrInitTimer(exId) {
  if (!session[exId]) session[exId] = { sets: [], open: true };
  if (!session[exId].timer) {
    const sec = restSecFor(exercises.find(x => x.id === exId));
    session[exId].timer = { mode: 'countdown', preset: sec, cur: sec, running: false };
  }
  return session[exId].timer;
}

function timerStart(exId) {
  const t = getOrInitTimer(exId);
  if (t.running) return;
  if (t.mode === 'countdown') {
    if (!t.cur || t.cur <= 0) t.cur = t.preset;
    const alreadyElapsed = (t.preset - t.cur) * 1000;
    t.startEpoch = Date.now() - alreadyElapsed;
  } else {
    t.startEpoch = Date.now() - ((t.cur || 0) * 1000);
  }
  t.running = true;
  saveSession();
  renderExList();
  restoreTimerInterval(exId);
}

function restoreTimerInterval(exId) {
  clearInterval(timerIntervals[exId]);
  timerIntervals[exId] = setInterval(() => {
    const tt = session[exId]?.timer;
    if (!tt || !tt.running || !tt.startEpoch) { clearInterval(timerIntervals[exId]); return; }
    const elapsed = Math.floor((Date.now() - tt.startEpoch) / 1000);
    if (tt.mode === 'countdown') {
      tt.cur = Math.max(0, tt.preset - elapsed);
      updateTimerDisplay(exId, tt);
      if (tt.cur <= 0) {
        clearInterval(timerIntervals[exId]);
        tt.running = false;
        saveSession();
        renderExList();
      }
    } else {
      tt.cur = elapsed;
      updateTimerDisplay(exId, tt);
    }
  }, 500);
}

function timerStop(exId) {
  const t = getOrInitTimer(exId);
  if (t.running && t.startEpoch) {
    const elapsed = Math.floor((Date.now() - t.startEpoch) / 1000);
    t.cur = t.mode === 'countdown' ? Math.max(0, t.preset - elapsed) : elapsed;
  }
  t.running = false;
  clearInterval(timerIntervals[exId]);
  saveSession();
  renderExList();
}

function timerReset(exId) {
  const t = getOrInitTimer(exId);
  t.running    = false;
  t.startEpoch = null;
  clearInterval(timerIntervals[exId]);
  t.cur = t.mode === 'countdown' ? t.preset : 0;
  saveSession();
  renderExList();
}

// 秒数を変える。計測中でも止めず、経過時間を保ったまま残りが増減する。
//   persist=true なら「この種目のレスト時間」として保存する。
function timerSetSec(exId, sec, persist) {
  sec = clampRest(sec);
  const ex = exercises.find(x => x.id === exId);
  const t  = getOrInitTimer(exId);
  if (persist && ex) { ex.restSec = sec; saveExercises(); }
  t.preset = sec;

  if (t.running && t.startEpoch && t.mode === 'countdown') {
    const elapsed = Math.floor((Date.now() - t.startEpoch) / 1000);
    t.cur = Math.max(0, sec - elapsed);
    if (t.cur <= 0) {          // 縮めた結果もう時間が過ぎていた
      t.running = false;
      clearInterval(timerIntervals[exId]);
    }
  } else if (!t.running) {
    t.cur = t.mode === 'countdown' ? sec : (t.cur || 0);
    t.startEpoch = null;
  }
  saveSession();
  renderExList();
}

// ±15秒。その場限りなので、保存されているレスト時間は変えない
function timerAdjust(exId, delta) {
  const t = getOrInitTimer(exId);
  if (t.mode !== 'countdown') return;
  timerSetSec(exId, (t.preset || 90) + delta, false);
}

// モード切替。計測中なら経過時間を引き継ぐ（止めない）
function timerSetMode(exId, mode) {
  const t = getOrInitTimer(exId);
  if (t.mode === mode) return;
  if (t.running && t.startEpoch) {
    const elapsed = Math.floor((Date.now() - t.startEpoch) / 1000);
    t.mode = mode;
    t.cur  = mode === 'countdown' ? Math.max(0, t.preset - elapsed) : elapsed;
    if (mode === 'countdown' && t.cur <= 0) {
      t.running = false;
      clearInterval(timerIntervals[exId]);
    }
  } else {
    t.mode = mode;
    t.cur  = mode === 'countdown' ? t.preset : 0;
    t.startEpoch = null;
  }
  saveSession();
  renderExList();
}

// 設定を変えたとき、動いていないタイマーを新しい秒数に合わせる
function refreshIdleTimers() {
  Object.keys(session).forEach(id => {
    const t = session[id] && session[id].timer;
    if (!t || t.running) return;
    const ex = exercises.find(x => x.id === +id);
    t.preset = restSecFor(ex);
    if (t.mode === 'countdown') t.cur = t.preset;
  });
  saveSession();
}

function updateTimerDisplay(exId, t) {
  const el = document.getElementById(`timer-disp-${exId}`);
  if (!el) { clearInterval(timerIntervals[exId]); return; }
  el.textContent = formatSec(t.cur);
  el.className   = 'timer-display ' + (!t.running ? 'idle'
    : t.mode === 'countdown' ? (t.cur <= 10 ? 'warning' : 'running-countdown')
    : 'running-stopwatch');
}

// ================================================================
//  EVENT BINDING
// ================================================================
function bindEvents() {
  const content = document.getElementById('content');
  if (!content) return;

  // ── Tab switching
  document.querySelectorAll('.tab-bar .tab-btn').forEach(btn => {
    btn.addEventListener('click', () => { currentTab = btn.dataset.tab; render(); });
  });

  // ── Workout
  document.getElementById('btn-add-ex')?.addEventListener('click', () => openModal());
  document.getElementById('btn-toggle-sort')?.addEventListener('click', () => { isSortMode = !isSortMode; render(); });
  document.getElementById('btn-save-log')?.addEventListener('click', saveLog);

  // ── HIIT
  document.getElementById('btn-hiit-start')?.addEventListener('click', startHiitWithCountdown);

  document.getElementById('btn-hiit-cancel-cd')?.addEventListener('click', () => {
    clearInterval(hiitCountdownTimer); hiitCountdownTimer = null;
    hiitState.status = 'idle'; render();
  });
  document.getElementById('btn-hiit-pause')?.addEventListener('click', () => {
    hiitState.status = 'paused'; clearInterval(hiitState.timerId); render();
  });
  document.getElementById('btn-hiit-resume')?.addEventListener('click', () => {
    initAudio(); hiitState.status = 'running';
    hiitState.timerId = setInterval(hiitTick, 1000); render();
  });
  document.getElementById('btn-hiit-reset')?.addEventListener('click', () => {
    clearInterval(hiitState.timerId); clearInterval(hiitCountdownTimer); hiitCountdownTimer = null;
    hiitState.status = 'idle'; hiitState.phase = 'work';
    hiitState.timeLeft = 20; hiitState.currentSet = 1; render();
  });
  document.getElementById('btn-hiit-countdown-toggle')?.addEventListener('click', () => {
    hiitSettings.countdownMode = !hiitSettings.countdownMode;
    DB.set('hiitSettings', hiitSettings); render();
  });
  document.getElementById('btn-audio-settings-toggle')?.addEventListener('click', () => {
    showAudioSettings = !showAudioSettings; render();
  });

  // ── Cardio save
  document.getElementById('btn-save-cardio')?.addEventListener('click', saveCardio);

  // Bind calc auto-fill inputs
  ['cardio-distance','cardio-time','cardio-speed'].forEach(id => {
    document.getElementById(id)?.addEventListener('input', calcCardioAuto);
  });

  // ── Stats / Transfer
  document.getElementById('btn-export')?.addEventListener('click', () => {
    const data = { app: 'ironlog', version: 3, exportedAt: new Date().toISOString(),
                   exercises, logs, cardioLogs };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = `ironlog_backup_${todayISO()}.json`;
    a.click(); URL.revokeObjectURL(url);
    showToast('⬆️ データをエクスポートしました');
  });

  document.getElementById('import-file-input')?.addEventListener('change', (e) => {
    const file = e.target.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = (evt) => {
      try {
        const data = JSON.parse(evt.target.result);
        // v1/v2（totalWeight を持つ旧バックアップ）も読める
        if (Array.isArray(data.exercises) && Array.isArray(data.logs)) {
          if (!confirm('現在のデータをすべて上書きしますか？')) return;
          exercises  = data.exercises.map(ex => ({ targetSets:3, presetWeights:[ex.weight], ...ex }));
          logs       = sortByDate(migrateLogs(data.logs));
          cardioLogs = sortByDate(migrateCardio(data.cardioLogs || []));
          saveExercises(); saveLogs(); saveCardioLogs();
          showToast('⬇️ データをインポートしました'); render();
        } else { showToast('⚠️ 無効なファイル形式です'); }
      } catch { showToast('⚠️ ファイルの読み込みに失敗しました'); }
    };
    reader.readAsText(file);
  });

  document.getElementById('btn-delete-all')?.addEventListener('click', () => {
    if (!confirm('全データを削除しますか？この操作は取り消せません。')) return;
    if (!confirm('本当に削除しますか？ログ・種目・すべてのデータが消えます。')) return;
    exercises = []; logs = []; cardioLogs = []; session = {}; sessionMeta = {};
    saveExercises(); saveLogs(); saveCardioLogs(); saveSession(); saveSessionMeta();
    showToast('🗑 全データを削除しました'); render();
  });

  // ── 設定：体重
  document.getElementById('set-bodyweight')?.addEventListener('change', (e) => {
    const v = Math.max(0, Math.min(300, parseFloat(e.target.value) || 0));
    settings.bodyWeight = v;
    saveSettings();
    showToast(v ? `⚖️ 体重を ${v}kg にしました` : '⚖️ 体重を未設定にしました');
    render();
  });

  // ── Content-level delegation (single handler)
  content.addEventListener('click', (e) => {
    // 日付をまたいだ記録を、どちらの日付で保存するか選ぶ
    const carryBtn = e.target.closest('[data-carryover-date]');
    if (carryBtn) {
      sessionMeta.date = carryBtn.dataset.carryoverDate;
      saveSessionMeta();
      showToast(`📅 ${jpDate(sessionMeta.date)} の記録として保存します`);
      render();
      return;
    }

    // ログの日付変更 / 削除
    const logEditBtn = e.target.closest('[data-log-edit]');
    if (logEditBtn) { openLogEditModal('workout', logEditBtn.dataset.logEdit); return; }

    const logDelBtn = e.target.closest('[data-log-del]');
    if (logDelBtn) {
      const id = logDelBtn.dataset.logDel;
      if (!confirm('この記録を削除しますか？この操作は取り消せません。')) return;
      logs = logs.filter(x => String(x.id) !== String(id));
      saveLogs(); showToast('🗑 記録を削除しました'); render(); return;
    }

    const cardioEditBtn = e.target.closest('[data-cardio-edit]');
    if (cardioEditBtn) { openLogEditModal('cardio', cardioEditBtn.dataset.cardioEdit); return; }

    const cardioDelBtn = e.target.closest('[data-cardio-del]');
    if (cardioDelBtn) {
      const id = cardioDelBtn.dataset.cardioDel;
      if (!confirm('この有酸素の記録を削除しますか？')) return;
      cardioLogs = cardioLogs.filter(x => String(x.id) !== String(id));
      saveCardioLogs(); showToast('🗑 記録を削除しました'); render(); return;
    }

    // Obsidian 書き出し（obsidian.js）
    const obsBtn = e.target.closest('[data-obsidian]');
    if (obsBtn) {
      if (typeof exportObsidian !== 'function') { showToast('⚠️ obsidian.js を読み込めていません'); return; }
      exportObsidian(obsBtn.dataset.obsidian);
      return;
    }

    // Audio option
    const audioOptBtn = e.target.closest('[data-audio-opt]');
    if (audioOptBtn) {
      audioSettings[audioOptBtn.dataset.audioType] = audioOptBtn.dataset.audioOpt;
      DB.set('audioSettings', audioSettings); render(); return;
    }

    // Cardio mode
    const cardioModeBtn = e.target.closest('[data-cardio-mode]');
    if (cardioModeBtn) {
      cardioMode = cardioModeBtn.dataset.cardioMode;
      DB.set('cardioMode', cardioMode); render(); return;
    }

    // Cardio type
    const cardioTypeBtn = e.target.closest('[data-cardio-type]');
    if (cardioTypeBtn) {
      cardioSession.distance    = document.getElementById('cardio-distance')?.value    || '';
      cardioSession.time        = document.getElementById('cardio-time')?.value        || '';
      cardioSession.speed       = document.getElementById('cardio-speed')?.value       || '';
      cardioSession.notes       = document.getElementById('cardio-notes')?.value       || '';
      cardioSession.sprintCount = document.getElementById('cardio-sprint-count')?.value|| '';
      cardioSession.type = cardioTypeBtn.dataset.cardioType;
      render(); return;
    }

    // Sprint dist preset
    const sprintDistBtn = e.target.closest('[data-sprint-dist]');
    if (sprintDistBtn) {
      cardioSession.sprintDist  = +sprintDistBtn.dataset.sprintDist;
      cardioSession.sprintCount = document.getElementById('cardio-sprint-count')?.value|| '';
      cardioSession.notes       = document.getElementById('cardio-notes')?.value       || '';
      render(); return;
    }

    // Move up
    const moveUpBtn = e.target.closest('[data-move-up]');
    if (moveUpBtn) {
      const id = +moveUpBtn.dataset.moveUp;
      const idx = exercises.findIndex(x => x.id === id);
      if (idx > 0) {
        [exercises[idx-1], exercises[idx]] = [exercises[idx], exercises[idx-1]];
        saveExercises(); renderExList();
      }
      return;
    }

    // Move down
    const moveDownBtn = e.target.closest('[data-move-down]');
    if (moveDownBtn) {
      const id = +moveDownBtn.dataset.moveDown;
      const idx = exercises.findIndex(x => x.id === id);
      if (idx >= 0 && idx < exercises.length - 1) {
        [exercises[idx], exercises[idx+1]] = [exercises[idx+1], exercises[idx]];
        saveExercises(); renderExList();
      }
      return;
    }

    // Toggle open/close
    const toggleBtn = e.target.closest('[data-toggle]');
    if (toggleBtn) {
      const id = +toggleBtn.dataset.toggle;
      if (!session[id]) session[id] = { sets: [], open: false };
      session[id].open = !session[id].open;
      saveSession(); renderExList(); return;
    }

    // Edit exercise
    const editBtn = e.target.closest('[data-edit]');
    if (editBtn) {
      const ex = exercises.find(x => x.id === +editBtn.dataset.edit);
      if (ex) openModal(ex); return;
    }

    // Delete exercise
    const delBtn = e.target.closest('[data-delete]');
    if (delBtn) {
      const id = +delBtn.dataset.delete;
      if (!confirm('この種目を削除しますか？')) return;
      exercises = exercises.filter(x => x.id !== id);
      saveExercises();
      delete session[id]; saveSession();
      clearInterval(timerIntervals[id]); renderExList(); return;
    }

    // Set tap
    const setTapBtn = e.target.closest('[data-set-tap]');
    if (setTapBtn) {
      const id = +setTapBtn.dataset.setTap;
      const ex = exercises.find(x => x.id === id); if (!ex) return;
      if (!session[id]) session[id] = { sets: [], open: true };
      // 最初の1セット目でその日を確定させる（日付をまたいでも記録が動かないように）
      if (!sessionMeta.startDate) {
        sessionMeta.startDate = todayISO();
        sessionMeta.date      = todayISO();
        saveSessionMeta();
      }
      session[id].sets.push({ time: nowHHMM(), weight: effectiveWeight(ex) });

      const rect   = setTapBtn.getBoundingClientRect();
      const ripple = document.createElement('div');
      ripple.className = 'ripple';
      ripple.style.left = ((e.clientX || rect.left + rect.width/2) - rect.left - 20) + 'px';
      ripple.style.top  = ((e.clientY || rect.top + rect.height/2) - rect.top  - 20) + 'px';
      setTapBtn.appendChild(ripple);
      setTimeout(() => ripple.remove(), 500);

      saveSession(); renderExList(); return;
    }

    // Undo last set (2-step)
    const undoBtn = e.target.closest('[data-undo]');
    if (undoBtn) {
      const id = +undoBtn.dataset.undo;
      if (undoBtn.dataset.confirm === 'true') {
        if (session[id]?.sets?.length > 0) {
          session[id].sets.pop();
          delete session[id].undoPending;
          if (session[id]._undoTimer) { clearTimeout(session[id]._undoTimer); delete session[id]._undoTimer; }
          saveSession(); renderExList();
          showToast('↩ 最後のセットを取り消しました');
        }
      } else {
        if (!session[id]) session[id] = { sets: [] };
        session[id].undoPending = true;
        if (session[id]._undoTimer) clearTimeout(session[id]._undoTimer);
        session[id]._undoTimer = setTimeout(() => {
          if (session[id]) { delete session[id].undoPending; delete session[id]._undoTimer; }
          renderExList();
        }, 3000);
        renderExList();
      }
      return;
    }

    // Timer start
    const tsBtn = e.target.closest('[data-timer-start]');
    if (tsBtn && !tsBtn.id?.includes('hiit')) { timerStart(+tsBtn.dataset.timerStart); return; }

    // Timer stop
    const tStopBtn = e.target.closest('[data-timer-stop]');
    if (tStopBtn && !tStopBtn.id?.includes('hiit')) { timerStop(+tStopBtn.dataset.timerStop); return; }

    // Timer reset
    const tResetBtn = e.target.closest('[data-timer-reset]');
    if (tResetBtn && !tResetBtn.id?.includes('hiit')) { timerReset(+tResetBtn.dataset.timerReset); return; }

    // モード切替（計測中でも経過時間を引き継ぐ）
    const tModeBtn = e.target.closest('[data-timer-mode]');
    if (tModeBtn) { timerSetMode(+tModeBtn.dataset.timerMode, tModeBtn.dataset.mode); return; }

    // レスト秒数。この種目に保存され、計測中なら残り時間が増減する
    const tPresetBtn = e.target.closest('[data-timer-preset]');
    if (tPresetBtn) { timerSetSec(+tPresetBtn.dataset.timerPreset, +tPresetBtn.dataset.sec, true); return; }

    // その他の秒数を入力する
    const tCustomBtn = e.target.closest('[data-timer-custom-open]');
    if (tCustomBtn) { openRestCustomModal(+tCustomBtn.dataset.timerCustomOpen); return; }

    // ±15秒（その場限り）
    const tAdjBtn = e.target.closest('[data-timer-adjust]');
    if (tAdjBtn) { timerAdjust(+tAdjBtn.dataset.timerAdjust, +tAdjBtn.dataset.delta); return; }

    // 種目ごとの指定をやめて共通に戻す
    const tClearBtn = e.target.closest('[data-timer-rest-clear]');
    if (tClearBtn) {
      const id = +tClearBtn.dataset.timerRestClear;
      const ex = exercises.find(x => x.id === id);
      if (ex) { ex.restSec = null; saveExercises(); }
      const t = getOrInitTimer(id);
      if (!t.running) { t.preset = restSecFor(ex); if (t.mode === 'countdown') t.cur = t.preset; }
      saveSession(); renderExList();
      showToast(`⏱ 共通の ${settings.defaultRestSec}秒に戻しました`);
      return;
    }

    // 設定カード：レスト時間の既定値
    const defRestBtn = e.target.closest('[data-default-rest]');
    if (defRestBtn) {
      settings.defaultRestSec = clampRest(defRestBtn.dataset.defaultRest);
      saveSettings(); refreshIdleTimers(); render(); return;
    }
    const defRestCustomBtn = e.target.closest('[data-default-rest-custom]');
    if (defRestCustomBtn) {
      openSecInputModal({
        title: 'レスト時間の既定値',
        value: settings.defaultRestSec, min: 5, max: 3600,
        onConfirm: (v) => { settings.defaultRestSec = v; saveSettings(); refreshIdleTimers(); render(); },
      });
      return;
    }
  });

  // change events
  content.addEventListener('change', (e) => {
    // Audio upload
    const audioUpload = e.target.closest('[data-audio-upload]');
    if (audioUpload) {
      const type = audioUpload.dataset.audioUpload;
      const file = e.target.files[0]; if (!file) return;
      AudioDB.set(`audio_${type}`, file).then(() => {
        audioUploadNames[type] = file.name;
        DB.set('audioUploadNames', audioUploadNames);
        showToast(`✅ ${file.name} を設定しました`); render();
      });
      return;
    }
  });
}

// ── Partial re-render ─────────────────────────────────────────────
function renderExList() {
  const list = document.getElementById('ex-list');
  if (!list) return;
  list.innerHTML = exercises.map((ex, idx) => renderExCard(ex, idx)).join('');

  // Update preview card
  const previewEntries = buildPreviewEntries();
  const btnSave = document.getElementById('btn-save-log');
  const existing = document.querySelector('.save-preview-card');

  if (previewEntries.length === 0) {
    existing?.remove();
  } else {
    const html = renderPreviewCard(previewEntries);
    if (existing) {
      existing.outerHTML = html;
    } else if (btnSave) {
      const div = document.createElement('div');
      div.innerHTML = html;
      btnSave.parentNode.insertBefore(div.firstElementChild, btnSave);
    }
  }
}

// ── Save log ─────────────────────────────────────────────────────
//   同じ日の記録があっても上書きしない。1日に何件でも積める。
function saveLog() {
  const entries = buildPreviewEntries();
  if (entries.length === 0) { showToast('⚠️ セット完了の種目がありません'); return; }

  const dayTotal = entries.reduce((sum, e) => sum + e.total, 0);
  const date     = sessionMeta.date || todayISO();

  // 過去の日付で保存するときに「保存を押した時刻」を入れると、
  // 23時台にやった記録が翌朝の時刻で残ってしまう。最後のセットの時刻を使う。
  const lastSet = entries.flatMap(e => e.setList || []).map(x => x.time).filter(Boolean).sort().pop();
  const time    = (date === todayISO()) ? nowHHMM() : (lastSet || nowHHMM());

  logs.unshift({ id: newId(), date, time, entries, total: dayTotal });
  saveLogs();

  const nth = logs.filter(l => l.date === date).length;

  session = {}; saveSession();
  sessionMeta = {}; saveSessionMeta();   // startDate も消える
  Object.keys(timerIntervals).forEach(k => clearInterval(timerIntervals[k]));
  showToast(nth > 1
    ? `✅ ${jpDate(date)} の${nth}件目として保存（${dayTotal.toLocaleString()} kg）`
    : `✅ 保存完了！総重量 ${dayTotal.toLocaleString()} kg`);
  render();
}

// ── ログの日付・時刻を変更する / 削除する ─────────────────────────
function openLogEditModal(kind, id) {
  const list = kind === 'cardio' ? cardioLogs : logs;
  const item = list.find(x => String(x.id) === String(id));
  if (!item) return;

  const label = kind === 'cardio'
    ? `${cardioDetail(item)}${item.notes ? '（' + item.notes + '）' : ''}`
    : item.entries.map(e => `${e.name} ${e.sets}set`).join('　');

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-sheet">
      <div class="modal-pill"></div>
      <div class="modal-title">記録の日付を変更</div>
      <div class="log-edit-summary">${esc(label)}</div>

      <label class="form-label">日付</label>
      <input class="form-input" id="log-edit-date" type="date" value="${item.date}" />

      <label class="form-label">時刻</label>
      <input class="form-input" id="log-edit-time" type="time" value="${item.time || ''}" />

      <div class="modal-btn-row">
        <button class="btn-cancel" id="log-edit-cancel">キャンセル</button>
        <button class="btn-confirm" id="log-edit-save">保存</button>
      </div>
      <button class="btn-delete-all" id="log-edit-delete" style="margin-top:12px">
        <span class="transfer-btn-icon">🗑</span>この記録を削除
      </button>
    </div>`;
  document.body.appendChild(overlay);

  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  overlay.querySelector('#log-edit-cancel').addEventListener('click', () => overlay.remove());

  overlay.querySelector('#log-edit-save').addEventListener('click', () => {
    const date = overlay.querySelector('#log-edit-date').value;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { showToast('⚠️ 日付を選んでください'); return; }
    item.date = date;
    item.time = overlay.querySelector('#log-edit-time').value || '';
    if (kind === 'cardio') saveCardioLogs(); else saveLogs();
    overlay.remove();
    showToast(`📅 ${jpDate(date)} に変更しました`);
    render();
  });

  overlay.querySelector('#log-edit-delete').addEventListener('click', () => {
    if (!confirm('この記録を削除しますか？この操作は取り消せません。')) return;
    if (kind === 'cardio') {
      cardioLogs = cardioLogs.filter(x => String(x.id) !== String(id));
      saveCardioLogs();
    } else {
      logs = logs.filter(x => String(x.id) !== String(id));
      saveLogs();
    }
    overlay.remove();
    showToast('🗑 記録を削除しました');
    render();
  });
}

// ── Save cardio ──────────────────────────────────────────────────
function saveCardio() {
  const notes = document.getElementById('cardio-notes')?.value || '';
  const stamp = { id: newId(), date: todayISO(), time: nowHHMM() };

  if (cardioMode === 'sprint') {
    const sprintDist  = parseFloat(document.getElementById('cardio-sprint-dist')?.value) || cardioSession.sprintDist;
    const sprintCount = parseInt(document.getElementById('cardio-sprint-count')?.value);
    if (!sprintCount || sprintCount <= 0) { showToast('⚠️ 本数を入力してください'); return; }
    cardioLogs.unshift({ ...stamp, mode: 'sprint', type: cardioSession.type, sprintDist, sprintCount, notes });
  } else {
    const distance = parseFloat(document.getElementById('cardio-distance')?.value) || 0;
    const minutes  = parseFloat(document.getElementById('cardio-time')?.value)     || 0;
    const speed    = parseFloat(document.getElementById('cardio-speed')?.value)    || 0;
    if (!distance && !minutes && !speed) { showToast('⚠️ 少なくとも1つ入力してください'); return; }
    cardioLogs.unshift({ ...stamp, mode: cardioMode, type: cardioSession.type, distance, minutes, speed, notes });
  }

  saveCardioLogs();
  cardioSession = { type: cardioSession.type, distance:'', time:'', speed:'', sprintDist:100, sprintCount:'', notes:'' };
  showToast('✅ 有酸素を記録しました'); render();
}

// 数値をひとつ入れてもらう小さなモーダル（レスト秒数・自重の割合など）
function openSecInputModal({ title, value, unit = '秒', min = 1, max = 3600, step = 5, help = '', onConfirm }) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-sheet">
      <div class="modal-pill"></div>
      <div class="modal-title">${esc(title)}</div>
      ${help ? `<div class="setting-help" style="margin-bottom:12px">${esc(help)}</div>` : ''}
      <div class="sec-input-row">
        <button class="btn-sec-step" data-step="${-step}">−${step}</button>
        <input class="form-input sec-input" id="sec-input" type="number" inputmode="numeric"
               min="${min}" max="${max}" value="${value}" />
        <span class="sec-unit">${esc(unit)}</span>
        <button class="btn-sec-step" data-step="${step}">＋${step}</button>
      </div>
      <div class="modal-btn-row">
        <button class="btn-cancel" data-sec-cancel="1">キャンセル</button>
        <button class="btn-confirm" data-sec-ok="1">決定</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const input = overlay.querySelector('#sec-input');
  input.focus(); input.select();
  const clamp = v => Math.max(min, Math.min(max, Math.round(+v || 0)));

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) { overlay.remove(); return; }
    const stepBtn = e.target.closest('[data-step]');
    if (stepBtn) { input.value = clamp((+input.value || 0) + +stepBtn.dataset.step); return; }
    if (e.target.closest('[data-sec-cancel]')) { overlay.remove(); return; }
    if (e.target.closest('[data-sec-ok]')) {
      const v = clamp(input.value);
      overlay.remove();
      onConfirm(v);
    }
  });
}

// タイマーの「その他」からレスト秒数を入れる
function openRestCustomModal(exId) {
  const t = getOrInitTimer(exId);
  openSecInputModal({
    title: 'レスト時間',
    value: t.preset || settings.customRestSec || settings.defaultRestSec,
    min: 5, max: 3600,
    help: 'ここで決めた秒数は、この種目のレスト時間として保存されます',
    onConfirm: (v) => { settings.customRestSec = v; saveSettings(); timerSetSec(exId, v, true); },
  });
}

// ================================================================
//  MODAL (Add / Edit)
// ================================================================
function openModal(ex = null) {
  const isEdit  = !!ex;
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  document.body.appendChild(overlay);

  const commonWeights = [2.5,5,10,15,20,25,30,35,40,45,50,60,70,80,100];
  const allPresets    = [...new Set([...(ex?.presetWeights || []), ...commonWeights])].sort((a,b)=>a-b);

  const BW_RATIOS = [
    { r: 100, label: '100%', hint: '懸垂・ディップス' },
    { r: 65,  label: '65%',  hint: '腕立て伏せ' },
    { r: 50,  label: '50%',  hint: '軽い自重種目' },
  ];

  // 編集中の値はここに持つ。描き直しても入力が消えないようにするため。
  const st = {
    name:       isEdit ? ex.name : '',
    weight:     isEdit ? ex.weight : 60,
    targetSets: ex?.targetSets || 3,
    restSec:    (ex && typeof ex.restSec === 'number') ? ex.restSec : null,  // null = 共通
    bodyweight: !!ex?.bodyweight,
    bwRatio:    ex?.bwRatio ?? 100,
    bodyWeight: settings.bodyWeight || 0,
    nameLocked: isEdit,
  };

  // 描き直す前に、入力欄の現在値を st に取り込む
  function capture() {
    const q = sel => overlay.querySelector(sel);
    if (q('#modal-name'))       st.name       = q('#modal-name').value;
    if (q('#modal-weight'))     st.weight     = q('#modal-weight').value === '' ? '' : parseFloat(q('#modal-weight').value);
    if (q('#modal-bodyweight')) st.bodyWeight = parseFloat(q('#modal-bodyweight').value) || 0;
  }

  function effective() {
    const add = parseFloat(st.weight) || 0;
    if (!st.bodyweight) return Math.round(add * 10) / 10;
    return Math.round(((st.bodyWeight || 0) * (st.bwRatio / 100) + add) * 10) / 10;
  }

  function refreshPreview() {
    const box = overlay.querySelector('.bw-preview');
    if (box) box.innerHTML = `1セットで扱う重量：<strong>${effective()} kg</strong>`;
  }

  function paint() {
    const restIsPreset = st.restSec !== null && REST_PRESETS.includes(st.restSec);
    const ratioIsPreset = BW_RATIOS.some(o => o.r === st.bwRatio);
    overlay.innerHTML = `
      <div class="modal-sheet">
        <div class="modal-pill"></div>
        <div class="modal-title">${isEdit ? '種目を編集' : '種目を追加'}</div>

        <label class="form-label">種目名</label>
        <div class="name-input-row">
          <input class="form-input${st.nameLocked ? ' name-locked' : ''}" id="modal-name" type="text"
            value="${esc(st.name)}" placeholder="例：ベンチプレス"
            ${st.nameLocked ? 'readonly' : ''} style="margin-bottom:0;flex:1" />
          ${st.nameLocked ? `<button class="btn-name-unlock" data-name-unlock="1">✏️ 変更</button>` : ''}
        </div>

        <label class="form-label" style="margin-top:16px">自重を加算</label>
        <div class="bw-toggle-row">
          <button class="hiit-toggle-btn${st.bodyweight ? ' active' : ''}" data-bw-toggle="1">
            ${st.bodyweight ? 'ON' : 'OFF'}
          </button>
          <span class="setting-help">懸垂・腕立てなど、体重そのものが負荷になる種目</span>
        </div>

        ${st.bodyweight ? `
          <div class="bw-ratio-row">
            ${BW_RATIOS.map(o => `
              <button class="btn-preset bw-ratio-btn${st.bwRatio === o.r ? ' selected' : ''}" data-bw-ratio="${o.r}">
                ${o.label}<span class="bw-ratio-hint">${o.hint}</span>
              </button>`).join('')}
            <button class="btn-preset bw-ratio-btn${!ratioIsPreset ? ' selected' : ''}" data-bw-ratio-custom="1">
              ${!ratioIsPreset ? `${st.bwRatio}%` : 'その他'}<span class="bw-ratio-hint">自分で決める</span>
            </button>
          </div>
          <div class="bw-weight-row">
            <span>体重</span>
            <input class="form-input" id="modal-bodyweight" type="number" inputmode="decimal"
                   step="0.1" min="0" max="300" value="${st.bodyWeight || ''}" placeholder="70" />
            <span>kg</span>
          </div>
          ${!st.bodyWeight ? `<div class="bw-warn">体重を入れないと自重ぶんが 0kg で計算されます</div>` : ''}
        ` : ''}

        <label class="form-label">${st.bodyweight ? '追加の重量 (kg)　※ベルトやダンベル。無ければ0' : '重量 (kg)'}</label>
        <div class="weight-presets-row">
          ${allPresets.map(w => `
            <button class="btn-weight-preset${parseFloat(st.weight) === w ? ' selected' : ''}" data-weight="${w}">${w}</button>
          `).join('')}
        </div>
        <input class="form-input" id="modal-weight" type="number" inputmode="decimal"
          value="${st.weight}" min="0" step="0.5" />

        ${st.bodyweight ? `<div class="bw-preview">1セットで扱う重量：<strong>${effective()} kg</strong></div>` : ''}

        <label class="form-label">目標セット数</label>
        <div class="target-sets-row">
          ${[1,2,3,4,5,6,7,8,9,10].map(n => `
            <button class="btn-target-set${st.targetSets===n?' selected':''}" data-target="${n}">${n}</button>
          `).join('')}
        </div>

        <label class="form-label">レスト時間</label>
        <div class="timer-presets">
          <button class="btn-preset${st.restSec === null ? ' selected' : ''}" data-modal-rest="default">
            共通（${settings.defaultRestSec}秒）
          </button>
          ${REST_PRESETS.map(p => `
            <button class="btn-preset${st.restSec === p ? ' selected' : ''}" data-modal-rest="${p}">${p}秒</button>
          `).join('')}
          <button class="btn-preset${(st.restSec !== null && !restIsPreset) ? ' selected' : ''}" data-modal-rest="custom">
            ${(st.restSec !== null && !restIsPreset) ? `${st.restSec}秒 ✏️` : 'その他'}
          </button>
        </div>

        <div class="modal-btn-row">
          <button class="btn-cancel" data-modal-cancel="1">キャンセル</button>
          <button class="btn-confirm" data-modal-confirm="1">保存</button>
        </div>
      </div>`;
  }

  paint();
  if (!isEdit) overlay.querySelector('#modal-name').focus();

  overlay.addEventListener('input', (e) => {
    if (e.target.id === 'modal-weight') {
      overlay.querySelectorAll('[data-weight]').forEach(b => b.classList.remove('selected'));
      st.weight = e.target.value === '' ? '' : parseFloat(e.target.value);
      refreshPreview();
    } else if (e.target.id === 'modal-bodyweight') {
      st.bodyWeight = parseFloat(e.target.value) || 0;
      refreshPreview();
    }
  });

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) { overlay.remove(); return; }

    if (e.target.closest('[data-name-unlock]')) {
      capture(); st.nameLocked = false; paint();
      const inp = overlay.querySelector('#modal-name'); inp.focus(); inp.select();
      return;
    }

    if (e.target.closest('[data-bw-toggle]')) {
      capture();
      st.bodyweight = !st.bodyweight;
      // 新規追加でONにした直後は、初期値の60kgが「追加のオモリ」として残ると紛らわしい
      if (st.bodyweight && !isEdit && parseFloat(st.weight) === 60) st.weight = 0;
      paint();
      return;
    }

    const ratioBtn = e.target.closest('[data-bw-ratio]');
    if (ratioBtn) { capture(); st.bwRatio = +ratioBtn.dataset.bwRatio; paint(); return; }

    if (e.target.closest('[data-bw-ratio-custom]')) {
      capture();
      openSecInputModal({
        title: '体重にかける割合', unit: '%', value: st.bwRatio, min: 1, max: 200, step: 5,
        help: '懸垂・ディップスは100%、腕立て伏せはおよそ65%が目安です',
        onConfirm: (v) => { st.bwRatio = v; paint(); },
      });
      return;
    }

    const wBtn = e.target.closest('[data-weight]');
    if (wBtn) { capture(); st.weight = parseFloat(wBtn.dataset.weight); paint(); return; }

    const tBtn = e.target.closest('[data-target]');
    if (tBtn) { capture(); st.targetSets = +tBtn.dataset.target; paint(); return; }

    const rBtn = e.target.closest('[data-modal-rest]');
    if (rBtn) {
      capture();
      const v = rBtn.dataset.modalRest;
      if (v === 'default') { st.restSec = null; paint(); }
      else if (v === 'custom') {
        openSecInputModal({
          title: 'レスト時間', value: st.restSec || settings.defaultRestSec, min: 5, max: 3600,
          onConfirm: (sec) => { st.restSec = sec; paint(); },
        });
      } else { st.restSec = +v; paint(); }
      return;
    }

    if (e.target.closest('[data-modal-cancel]')) { overlay.remove(); return; }

    if (e.target.closest('[data-modal-confirm]')) {
      capture();
      const name   = String(st.name || '').trim();
      const weight = parseFloat(st.weight) || 0;
      if (!name) { showToast('⚠️ 種目名を入力してください'); return; }

      // モーダルで体重を入れ直していたら設定にも反映する
      if (st.bodyweight && st.bodyWeight !== (settings.bodyWeight || 0)) {
        settings.bodyWeight = st.bodyWeight;
        saveSettings();
      }

      const fields = {
        name, weight,
        targetSets: st.targetSets,
        bodyweight: st.bodyweight,
        bwRatio:    st.bwRatio,
        restSec:    st.restSec,
      };

      if (isEdit) {
        const updatedPresets = [...new Set([...(ex.presetWeights || []), weight])];
        exercises = exercises.map(x => x.id === ex.id ? { ...x, ...fields, presetWeights: updatedPresets } : x);
      } else {
        exercises.push({ id: uid(), ...fields, presetWeights: [weight] });
      }
      saveExercises();
      refreshIdleTimers();
      overlay.remove();
      render();
      return;
    }
  });
}

// ================================================================
//  iOS — 横スワイプ無効化
// ================================================================
let _touchStartX = 0, _touchStartY = 0;

document.addEventListener('touchstart', (e) => {
  _touchStartX = e.touches[0].clientX;
  _touchStartY = e.touches[0].clientY;
}, { passive: true });

document.addEventListener('touchmove', (e) => {
  const dx = Math.abs(e.touches[0].clientX - _touchStartX);
  const dy = Math.abs(e.touches[0].clientY - _touchStartY);
  if (dx > dy * 1.5 && dx > 15) e.preventDefault();
}, { passive: false });

// ================================================================
//  VISIBILITY CHANGE — タイマー同期
// ================================================================
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  Object.keys(session).forEach(id => {
    const exId = +id;
    const t    = session[exId]?.timer;
    if (!t?.running || !t.startEpoch) return;
    const elapsed = Math.floor((Date.now() - t.startEpoch) / 1000);
    if (t.mode === 'countdown') {
      t.cur = Math.max(0, t.preset - elapsed);
      if (t.cur <= 0) { t.running = false; clearInterval(timerIntervals[exId]); }
    } else {
      t.cur = elapsed;
    }
  });
  if (currentTab === 'workout') renderExList();
});

// ================================================================
//  PWA SERVICE WORKER
// ================================================================
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('./sw.js'); });
}

// ================================================================
//  外部モジュール用の窓口（obsidian.js / sync.js から使う）
//  app.js の state は let 宣言なので window から直接は触れない。
//  読み書きはすべてここを通す。
// ================================================================
window.IRONLOG = {
  getExercises:  () => exercises,
  getLogs:       () => logs,
  getCardioLogs: () => cardioLogs,

  setExercises(v)  { exercises  = v || [];                          DB.set('exercises', exercises); },
  setLogs(v)       { logs       = sortByDate(migrateLogs(v || [])); DB.set('logs', logs); },
  setCardioLogs(v) { cardioLogs = sortByDate(migrateCardio(v||[])); DB.set('cardioLogs', cardioLogs); },

  rerender: () => render(),
  helpers:  { esc, uid, newId, todayISO, jpDate, jpDateShort, isoWeekday,
              totalWeight, trainedDays, entryWeightLabel, cardioDetail, showToast },
};

// ================================================================
//  INIT
// ================================================================
render();
