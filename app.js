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
  ...ex
}));

let logs        = DB.get('logs', []);
let totalWeight = DB.get('totalWeight', 0);
let cardioLogs  = DB.get('cardioLogs', []);
let currentTab  = 'workout';
let isSortMode  = false;

// session: { [exId]: { sets:[{time,weight}], open, timer, undoPending } }
let session = {};

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
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}年${d.getMonth()+1}月${d.getDate()}日`;
}
function nowHHMM() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}
function formatSec(s) {
  const m  = String(Math.floor(s/60)).padStart(2,'0');
  const sc = String(s%60).padStart(2,'0');
  return `${m}:${sc}`;
}
function uid() { return Date.now() + Math.random(); }

function saveExercises() { DB.set('exercises', exercises); }
function saveLogs()       { DB.set('logs', logs); }
function saveTotalWeight(){ DB.set('totalWeight', totalWeight); }
function saveCardioLogs() { DB.set('cardioLogs', cardioLogs); }

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
  if (over)            color = 'var(--accent)';
  else if (count >= target) color = 'var(--green)';
  else if (count / target >= 0.5) color = 'var(--accent2)';
  else                 color = null; // empty

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
function renderWorkout() {
  const previewEntries = buildPreviewEntries();
  const previewHtml = previewEntries.length > 0 ? `
    <div class="save-preview-card">
      <div class="save-preview-title">📋 今回の記録プレビュー</div>
      ${previewEntries.map(e => `
        <div class="save-preview-row">
          <span class="save-preview-name">${e.name}</span>
          <span class="save-preview-sets">${e.sets} set</span>
          <span class="save-preview-total">${e.total.toLocaleString()} kg</span>
        </div>
      `).join('')}
    </div>
  ` : '';

  return `
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
    <button class="btn-save-log" id="btn-save-log">💾 今日のログを保存</button>
  `;
}

function buildPreviewEntries() {
  return exercises
    .map(ex => {
      const s = session[ex.id];
      if (!s || s.sets.length === 0) return null;
      const total = s.sets.reduce((sum, st) => sum + (st.weight ?? ex.weight), 0);
      return { name: ex.name, sets: s.sets.length, total };
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
        <div class="ex-name">${ex.name}</div>
        <div class="ex-header-bottom">
          <div class="ex-weight">${ex.weight} kg</div>
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
              <span class="set-history-weight">${s.weight ?? ex.weight}kg</span>
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
function renderTimer(exId, sess) {
  const t = sess.timer || { mode: 'countdown', preset: 90, cur: 90, running: false };

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

  const PRESETS = [60, 90, 120, 180];

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
      ${PRESETS.map(p => `
        <button class="btn-preset${t.preset===p?' selected':''}" data-timer-preset="${exId}" data-sec="${p}">
          ${p}秒
        </button>
      `).join('')}
    </div>
    <div class="timer-custom-row">
      <span>カスタム</span>
      <input class="input-num" type="number" min="10" max="600"
        value="${t.preset}" data-timer-custom="${exId}" />
      <span>秒</span>
    </div>
    ` : ''}

    <div class="timer-display ${cls}" id="timer-disp-${exId}">
      ${formatSec(displaySec)}
    </div>

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
              ${audioUploadNames[key] ? '✓ ' + audioUploadNames[key] : 'MP3'}
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
  const todayCardio = cardioLogs.filter(l => l.date === todayStr());
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
          ${todayCardio.map(l => renderCardioLogItem(l)).join('')}
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
      <input class="form-input" type="text" placeholder="任意" id="cardio-notes" value="${cardioSession.notes}" />
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
      <input class="form-input" type="text" placeholder="任意" id="cardio-notes" value="${cardioSession.notes}" />
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
      <input class="form-input" type="text" placeholder="任意" id="cardio-notes" value="${cardioSession.notes}" />
    </div>`;
}

function renderCardioLogItem(l) {
  const typeLabel = l.type === 'run' ? '🏃' : l.type === 'walk' ? '🚶' : '🚴';
  let detail;
  if (l.mode === 'sprint') {
    detail = `${l.sprintDist}m × ${l.sprintCount}本`;
  } else {
    const parts = [];
    if (l.distance) parts.push(`${l.distance}km`);
    if (l.time)     parts.push(`${l.time}分`);
    if (l.speed)    parts.push(`${l.speed}km/h`);
    detail = parts.join(' / ');
  }
  return `
    <div class="cardio-log-item">
      <span class="cardio-log-type">${typeLabel}</span>
      <span class="cardio-log-detail">${detail}</span>
      ${l.notes ? `<span class="cardio-log-notes">${l.notes}</span>` : ''}
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
function renderLog() {
  if (logs.length === 0) return `<div class="empty">まだログがありません</div>`;
  return logs.map(log => `
    <div class="log-card">
      <div class="log-date">${log.date}</div>
      ${log.entries.map(e => `
        <div class="log-entry">
          <span class="log-entry-name">${e.name}</span>
          <span class="log-entry-detail">${e.sets}set</span>
          <span class="log-entry-sub">${(e.total ?? e.weight * e.sets).toLocaleString()}kg</span>
        </div>
      `).join('')}
      <div class="log-total">本日の総重量：<strong>${log.total.toLocaleString()} kg</strong></div>
    </div>
  `).join('');
}

// ── Stats tab ────────────────────────────────────────────────────
function renderStats() {
  const avg    = logs.length > 0 ? Math.round(totalWeight / logs.length) : 0;
  const recent = [...logs].slice(0, 8).reverse();
  const maxTotal = recent.length > 0 ? Math.max(...recent.map(l=>l.total)) : 1;

  return `
    <div class="stat-grid">
      <div class="stat-card wide">
        <div class="stat-label">累計扱った総重量</div>
        <div class="stat-value">${totalWeight.toLocaleString()} <span class="stat-unit">kg</span></div>
      </div>
      <div class="stat-card">
        <div class="stat-label">記録日数</div>
        <div class="stat-value">${logs.length} <span class="stat-unit">日</span></div>
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
            <span class="bar-label">${log.date.replace(/\d{4}年/,'')}</span>
            <div class="bar-track">
              <div class="bar-fill" style="width:${Math.round((log.total/maxTotal)*100)}%"></div>
            </div>
            <span class="bar-val">${log.total.toLocaleString()}kg</span>
          </div>
        `).join('')}
      </div>
    ` : ''}

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
    session[exId].timer = { mode: 'countdown', preset: 90, cur: 90, running: false };
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
    const data = { exercises, logs, totalWeight, cardioLogs };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = `ironlog_backup_${new Date().toISOString().slice(0,10)}.json`;
    a.click(); URL.revokeObjectURL(url);
    showToast('⬆️ データをエクスポートしました');
  });

  document.getElementById('import-file-input')?.addEventListener('change', (e) => {
    const file = e.target.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = (evt) => {
      try {
        const data = JSON.parse(evt.target.result);
        if (data.exercises && data.logs && typeof data.totalWeight === 'number') {
          if (!confirm('現在のデータをすべて上書きしますか？')) return;
          exercises   = data.exercises.map(ex => ({ targetSets:3, presetWeights:[ex.weight], ...ex }));
          logs        = data.logs;
          totalWeight = data.totalWeight;
          if (data.cardioLogs) cardioLogs = data.cardioLogs;
          saveExercises(); saveLogs(); saveTotalWeight(); saveCardioLogs();
          showToast('⬇️ データをインポートしました'); render();
        } else { showToast('⚠️ 無効なファイル形式です'); }
      } catch { showToast('⚠️ ファイルの読み込みに失敗しました'); }
    };
    reader.readAsText(file);
  });

  document.getElementById('btn-delete-all')?.addEventListener('click', () => {
    if (!confirm('全データを削除しますか？この操作は取り消せません。')) return;
    if (!confirm('本当に削除しますか？ログ・種目・すべてのデータが消えます。')) return;
    exercises = []; logs = []; totalWeight = 0; cardioLogs = []; session = {};
    saveExercises(); saveLogs(); saveTotalWeight(); saveCardioLogs(); saveSession();
    showToast('🗑 全データを削除しました'); render();
  });

  // ── Content-level delegation (single handler)
  content.addEventListener('click', (e) => {
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
      session[id].sets.push({ time: nowHHMM(), weight: ex.weight });

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

    // Timer mode
    const tModeBtn = e.target.closest('[data-timer-mode]');
    if (tModeBtn) {
      const id   = +tModeBtn.dataset.timerMode;
      const mode = tModeBtn.dataset.mode;
      timerStop(id);
      const t = getOrInitTimer(id);
      t.mode = mode; t.cur = mode === 'countdown' ? t.preset : 0; t.startEpoch = null;
      saveSession(); renderExList(); return;
    }

    // Timer preset
    const tPresetBtn = e.target.closest('[data-timer-preset]');
    if (tPresetBtn) {
      const id  = +tPresetBtn.dataset.timerPreset;
      const sec = +tPresetBtn.dataset.sec;
      timerStop(id);
      const t = getOrInitTimer(id);
      t.preset = sec; t.cur = sec; t.startEpoch = null;
      saveSession(); renderExList(); return;
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

    // Timer custom input
    const customInput = e.target.closest('[data-timer-custom]');
    if (customInput) {
      const id  = +customInput.dataset.timerCustom;
      const val = Math.max(10, Math.min(600, +customInput.value || 90));
      timerStop(id);
      const t = getOrInitTimer(id);
      t.preset = val; t.cur = val;
      saveSession(); renderExList();
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
    const html = `
      <div class="save-preview-card">
        <div class="save-preview-title">📋 今回の記録プレビュー</div>
        ${previewEntries.map(e => `
          <div class="save-preview-row">
            <span class="save-preview-name">${e.name}</span>
            <span class="save-preview-sets">${e.sets} set</span>
            <span class="save-preview-total">${e.total.toLocaleString()} kg</span>
          </div>
        `).join('')}
      </div>`;
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
function saveLog() {
  const entries = exercises
    .map(ex => {
      const s = session[ex.id];
      if (!s || s.sets.length === 0) return null;
      const total = s.sets.reduce((sum, st) => sum + (st.weight ?? ex.weight), 0);
      return { name: ex.name, sets: s.sets.length, total };
    })
    .filter(Boolean);

  if (entries.length === 0) { showToast('⚠️ セット完了の種目がありません'); return; }

  const dayTotal = entries.reduce((sum, e) => sum + e.total, 0);
  logs = [{ date: todayStr(), entries, total: dayTotal }, ...logs.filter(l => l.date !== todayStr())];
  totalWeight += dayTotal;
  saveLogs(); saveTotalWeight();

  session = {}; saveSession();
  Object.keys(timerIntervals).forEach(k => clearInterval(timerIntervals[k]));
  showToast(`✅ 保存完了！本日の総重量 ${dayTotal.toLocaleString()} kg`);
  render();
}

// ── Save cardio ──────────────────────────────────────────────────
function saveCardio() {
  const notes = document.getElementById('cardio-notes')?.value || '';

  if (cardioMode === 'sprint') {
    const sprintDist  = parseFloat(document.getElementById('cardio-sprint-dist')?.value) || cardioSession.sprintDist;
    const sprintCount = parseInt(document.getElementById('cardio-sprint-count')?.value);
    if (!sprintCount || sprintCount <= 0) { showToast('⚠️ 本数を入力してください'); return; }
    cardioLogs.unshift({ date: todayStr(), mode: 'sprint', type: cardioSession.type, sprintDist, sprintCount, notes });
  } else {
    const distance = parseFloat(document.getElementById('cardio-distance')?.value) || 0;
    const time     = parseFloat(document.getElementById('cardio-time')?.value)     || 0;
    const speed    = parseFloat(document.getElementById('cardio-speed')?.value)    || 0;
    if (!distance && !time && !speed) { showToast('⚠️ 少なくとも1つ入力してください'); return; }
    cardioLogs.unshift({ date: todayStr(), mode: cardioMode, type: cardioSession.type, distance, time, speed, notes });
  }

  saveCardioLogs();
  cardioSession = { type: cardioSession.type, distance:'', time:'', speed:'', sprintDist:100, sprintCount:'', notes:'' };
  showToast('✅ 有酸素を記録しました'); render();
}

// ================================================================
//  MODAL (Add / Edit)
// ================================================================
function openModal(ex = null) {
  const isEdit = !!ex;
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';

  const presets      = ex?.presetWeights || [];
  const commonWeights= [2.5,5,10,15,20,25,30,35,40,45,50,60,70,80,100];
  const allPresets   = [...new Set([...presets, ...commonWeights])].sort((a,b)=>a-b);
  const currentW     = isEdit ? ex.weight : 60;
  const targetSets   = ex?.targetSets || 3;

  overlay.innerHTML = `
    <div class="modal-sheet">
      <div class="modal-pill"></div>
      <div class="modal-title">${isEdit ? '種目を編集' : '種目を追加'}</div>

      <label class="form-label">種目名</label>
      <div class="name-input-row">
        <input class="form-input${isEdit ? ' name-locked' : ''}" id="modal-name" type="text"
          value="${isEdit ? ex.name : ''}" placeholder="例：ベンチプレス"
          ${isEdit ? 'readonly' : ''} style="margin-bottom:0;flex:1" />
        ${isEdit ? `<button class="btn-name-unlock" id="btn-name-unlock">✏️ 変更</button>` : ''}
      </div>

      <label class="form-label" style="margin-top:16px">重量 (kg)</label>
      <div class="weight-presets-row">
        ${allPresets.map(w => `
          <button class="btn-weight-preset${currentW === w ? ' selected' : ''}" data-weight="${w}">${w}</button>
        `).join('')}
      </div>
      <input class="form-input" id="modal-weight" type="number"
        value="${currentW}" min="0" step="0.5" />

      <label class="form-label">目標セット数</label>
      <div class="target-sets-row">
        ${[1,2,3,4,5,6,7,8,9,10].map(n => `
          <button class="btn-target-set${targetSets===n?' selected':''}" data-target="${n}">${n}</button>
        `).join('')}
      </div>

      <div class="modal-btn-row">
        <button class="btn-cancel" id="modal-cancel">キャンセル</button>
        <button class="btn-confirm" id="modal-confirm">保存</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);
  if (!isEdit) document.getElementById('modal-name').focus();

  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

  document.getElementById('btn-name-unlock')?.addEventListener('click', () => {
    const inp = document.getElementById('modal-name');
    inp.removeAttribute('readonly'); inp.classList.remove('name-locked');
    inp.focus(); inp.select();
    document.getElementById('btn-name-unlock').style.display = 'none';
  });

  overlay.querySelectorAll('[data-weight]').forEach(btn => {
    btn.addEventListener('click', () => {
      overlay.querySelectorAll('[data-weight]').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      document.getElementById('modal-weight').value = btn.dataset.weight;
    });
  });

  document.getElementById('modal-weight')?.addEventListener('input', () => {
    overlay.querySelectorAll('[data-weight]').forEach(b => b.classList.remove('selected'));
  });

  let selectedTarget = targetSets;
  overlay.querySelectorAll('[data-target]').forEach(btn => {
    btn.addEventListener('click', () => {
      overlay.querySelectorAll('[data-target]').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      selectedTarget = +btn.dataset.target;
    });
  });

  document.getElementById('modal-cancel').addEventListener('click', () => overlay.remove());

  document.getElementById('modal-confirm').addEventListener('click', () => {
    const name   = document.getElementById('modal-name').value.trim();
    const weight = parseFloat(document.getElementById('modal-weight').value) || 0;
    if (!name) { showToast('⚠️ 種目名を入力してください'); return; }

    if (isEdit) {
      const updatedPresets = [...new Set([...(ex.presetWeights || []), weight])];
      exercises = exercises.map(x => x.id === ex.id
        ? { ...x, name, weight, targetSets: selectedTarget, presetWeights: updatedPresets } : x);
    } else {
      exercises.push({ id: uid(), name, weight, targetSets: selectedTarget, presetWeights: [weight] });
    }
    saveExercises(); overlay.remove(); render();
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
//  INIT
// ================================================================
render();
