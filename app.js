// ================================================================
//  IRON LOG — PWA 筋トレ記録アプリ
// ================================================================

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
  { id: 1, name: 'ベンチプレス', weight: 60 },
  { id: 2, name: 'スクワット',   weight: 80 },
  { id: 3, name: 'デッドリフト', weight: 100 },
]);
let logs         = DB.get('logs', []);
let totalWeight  = DB.get('totalWeight', 0);
let currentTab   = 'workout';
let isSortMode = false;

// session: { [exId]: { sets: [{time}] } }
let session = {};

// HIIT State
let hiitState = {
  status: 'idle', // idle, running, paused, finished
  phase: 'work',  // work, rest
  timeLeft: 20,
  currentSet: 1,
  totalSets: 8,
  timerId: null
};

// Web Audio API for Beep
let audioCtx;
function initAudio() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (audioCtx.state === 'suspended') {
    audioCtx.resume();
  }
}

function playBeep(type) {
  if (!audioCtx) return;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.connect(gain);
  gain.connect(audioCtx.destination);
  
  if (type === 'work') {
    osc.type = 'square';
    osc.frequency.setValueAtTime(880, audioCtx.currentTime); // 高音
    gain.gain.setValueAtTime(0.1, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.6);
    osc.start(audioCtx.currentTime);
    osc.stop(audioCtx.currentTime + 0.6);
  } else if (type === 'rest') {
    osc.type = 'square';
    osc.frequency.setValueAtTime(440, audioCtx.currentTime); // 中音
    gain.gain.setValueAtTime(0.1, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.4);
    osc.start(audioCtx.currentTime);
    osc.stop(audioCtx.currentTime + 0.4);
  } else if (type === 'finish') {
    osc.type = 'square';
    osc.frequency.setValueAtTime(1046.5, audioCtx.currentTime); // 完了音
    gain.gain.setValueAtTime(0.1, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 1.0);
    osc.start(audioCtx.currentTime);
    osc.stop(audioCtx.currentTime + 1.0);
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
  const m = String(Math.floor(s/60)).padStart(2,'0');
  const sc = String(s%60).padStart(2,'0');
  return `${m}:${sc}`;
}
function uid() { return Date.now() + Math.random(); }

function saveExercises() { DB.set('exercises', exercises); }
function saveLogs()       { DB.set('logs', logs); }
function saveTotalWeight(){ DB.set('totalWeight', totalWeight); }

// ── Toast ────────────────────────────────────────────────────────
let toastTimer;
function showToast(msg) {
  let el = document.querySelector('.toast');
  if (el) el.remove();
  el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.remove(), 2800);
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
        : currentTab === 'hiit'  ? renderHiit()
        : currentTab === 'log'   ? renderLog()
        :                          renderStats()}
    </div>
  `;
  bindEvents();
}

// ── Header ──────────────────────────────────────────────────────
function renderHeader() {
  return `
    <header class="app-header">
      <div>
        <div class="app-title">IRON LOG</div>
      </div>
      <div class="app-date">${todayStr()}</div>
    </header>
  `;
}

// ── Tab bar ─────────────────────────────────────────────────────
function renderTabBar() {
  const tabs = [
    ['workout', '🏋️', 'トレーニング'],
    ['hiit',    '🚴', 'ヒート'],
    ['log',     '📅', 'ログ'],
    ['stats',   '📊', '統計'],
  ];
  return `<nav class="tab-bar">
    ${tabs.map(([id, icon, label]) =>
      `<button class="tab-btn${currentTab===id?' active':''}" data-tab="${id}">
        ${icon} ${label}
      </button>`
    ).join('')}
  </nav>`;
}

// ── Workout tab ──────────────────────────────────────────────────
function renderWorkout() {
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
    <button class="btn-save-log" id="btn-save-log">💾 今日のログを保存</button>
  `;
}

function renderExCard(ex, index) {
  const sess = session[ex.id] || { sets: [] };
  const setCount = sess.sets.length;

  return `
  <div class="ex-card" data-exid="${ex.id}">
    <div class="ex-card-header">
      <div class="ex-info">
        <div class="ex-name">${ex.name}</div>
        <div class="ex-weight">${ex.weight} kg</div>
      </div>
      <div class="ex-card-actions">
        ${isSortMode ? `
          <button class="btn-icon" data-move-up="${ex.id}" title="上に移動" ${index === 0 ? 'disabled' : ''}>↑</button>
          <button class="btn-icon" data-move-down="${ex.id}" title="下に移動" ${index === exercises.length - 1 ? 'disabled' : ''}>↓</button>
        ` : ''}
        <button class="btn-icon" data-edit="${ex.id}" title="編集">✏️</button>
        <button class="btn-icon danger" data-delete="${ex.id}" title="削除">🗑</button>
        <button class="btn-icon" data-toggle="${ex.id}" title="開閉">
          ${sess.open ? '▲' : '▼'}
        </button>
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
              ${i === setCount-1 ? `<button class="btn-undo-single" data-undo="${ex.id}">↩ 取消</button>` : ''}
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
  const t = sess.timer || { mode: 'countdown', sec: 90, running: false, cur: 90, preset: 90 };
  const displaySec = t.running ? t.cur : (t.mode==='countdown' ? t.preset : 0);
  const cls = !t.running ? 'idle'
    : t.mode==='countdown'
      ? (t.cur <= 10 ? 'warning' : 'running-countdown')
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
      ${PRESETS.map(p=>`
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
      ${formatSec(t.mode==='countdown' ? (t.running ? t.cur : t.preset) : (t.running ? t.cur : 0))}
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
  const phaseText = hiitState.status === 'finished' ? 'COMPLETED' : hiitState.phase === 'work' ? 'WORK (20s)' : 'REST (10s)';
  const colorClass = hiitState.status === 'finished' ? 'hiit-finish' : hiitState.phase === 'work' ? 'hiit-work' : 'hiit-rest';
  
  return `
    <div class="hiit-container">
      <div class="hiit-header">HIIT BIKE</div>
      <div class="hiit-set" id="hiit-set-disp">Set: ${hiitState.currentSet} / ${hiitState.totalSets}</div>
      <div class="hiit-phase ${colorClass}" id="hiit-phase-disp">${phaseText}</div>
      <div class="hiit-timer ${colorClass}" id="hiit-timer-disp">${hiitState.timeLeft}</div>
      
      <div class="timer-ctrl-row" style="margin-top: 30px;">
        ${hiitState.status === 'idle' || hiitState.status === 'finished' ? `
          <button class="btn-timer-start" id="btn-hiit-start">▶ スタート</button>
        ` : hiitState.status === 'running' ? `
          <button class="btn-timer-stop" id="btn-hiit-pause">⏸ ストップ</button>
        ` : `
          <button class="btn-timer-start" id="btn-hiit-resume">▶ リスタート</button>
        `}
        <button class="btn-timer-reset" id="btn-hiit-reset">リセット</button>
      </div>
    </div>
  `;
}

function updateHiitDisplay() {
  const timerEl = document.getElementById('hiit-timer-disp');
  if (!timerEl) return;
  const phaseEl = document.getElementById('hiit-phase-disp');
  const setEl = document.getElementById('hiit-set-disp');
  
  timerEl.textContent = hiitState.timeLeft;
  setEl.textContent = `Set: ${hiitState.currentSet} / ${hiitState.totalSets}`;
  
  const phaseText = hiitState.status === 'finished' ? 'COMPLETED' : hiitState.phase === 'work' ? 'WORK (20s)' : 'REST (10s)';
  const colorClass = hiitState.status === 'finished' ? 'hiit-finish' : hiitState.phase === 'work' ? 'hiit-work' : 'hiit-rest';
  
  phaseEl.textContent = phaseText;
  timerEl.className = `hiit-timer ${colorClass}`;
  phaseEl.className = `hiit-phase ${colorClass}`;
}

function hiitTick() {
  hiitState.timeLeft--;
  if (hiitState.timeLeft <= 0) {
    if (hiitState.phase === 'work') {
      hiitState.phase = 'rest';
      hiitState.timeLeft = 10;
      playBeep('rest');
    } else {
      if (hiitState.currentSet >= hiitState.totalSets) {
        hiitState.status = 'finished';
        hiitState.timeLeft = 0;
        playBeep('finish');
        clearInterval(hiitState.timerId);
        render();
        return;
      } else {
        hiitState.currentSet++;
        hiitState.phase = 'work';
        hiitState.timeLeft = 20;
        playBeep('work');
      }
    }
  }
  updateHiitDisplay();
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
          <span class="log-entry-detail">${e.weight}kg × ${e.sets}set</span>
          <span class="log-entry-sub">${(e.weight*e.sets).toLocaleString()}kg</span>
        </div>
      `).join('')}
      <div class="log-total">本日の総重量：<strong>${log.total.toLocaleString()} kg</strong></div>
    </div>
  `).join('');
}

// ── Stats tab ────────────────────────────────────────────────────
function renderStats() {
  const avg = logs.length > 0 ? Math.round(totalWeight / logs.length) : 0;
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
  if (t.mode === 'countdown' && t.cur <= 0) t.cur = t.preset;
  if (t.mode === 'stopwatch') t.cur = 0;
  t.running = true;

  renderExList();

  timerIntervals[exId] = setInterval(() => {
    const tt = session[exId]?.timer;
    if (!tt) { clearInterval(timerIntervals[exId]); return; }

    if (tt.mode === 'countdown') {
      tt.cur = Math.max(0, tt.cur - 1);
      updateTimerDisplay(exId, tt);
      if (tt.cur <= 0) {
        clearInterval(timerIntervals[exId]);
        tt.running = false;
        renderExList();
      }
    } else {
      tt.cur += 1;
      updateTimerDisplay(exId, tt);
    }
  }, 1000);
}

function timerStop(exId) {
  const t = getOrInitTimer(exId);
  t.running = false;
  clearInterval(timerIntervals[exId]);
  renderExList();
}

function timerReset(exId) {
  const t = getOrInitTimer(exId);
  t.running = false;
  clearInterval(timerIntervals[exId]);
  t.cur = t.mode === 'countdown' ? t.preset : 0;
  renderExList();
}

function updateTimerDisplay(exId, t) {
  const el = document.getElementById(`timer-disp-${exId}`);
  if (!el) { clearInterval(timerIntervals[exId]); return; }
  const sec = t.cur;
  el.textContent = formatSec(sec);
  el.className = 'timer-display ' + (!t.running ? 'idle'
    : t.mode === 'countdown'
      ? (t.cur <= 10 ? 'warning' : 'running-countdown')
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
    btn.addEventListener('click', () => {
      currentTab = btn.dataset.tab;
      render();
    });
  });

  // ── Add exercise
  document.getElementById('btn-add-ex')?.addEventListener('click', () => openModal());

  // ── Toggle Sort Mode
  document.getElementById('btn-toggle-sort')?.addEventListener('click', () => {
    isSortMode = !isSortMode;
    render();
  });

  // ── Save log
  document.getElementById('btn-save-log')?.addEventListener('click', saveLog);

  // ── HIIT Events
  document.getElementById('btn-hiit-start')?.addEventListener('click', () => {
    initAudio();
    if (hiitState.status === 'finished') {
      hiitState.currentSet = 1;
      hiitState.phase = 'work';
      hiitState.timeLeft = 20;
    }
    hiitState.status = 'running';
    playBeep('work');
    hiitState.timerId = setInterval(hiitTick, 1000);
    render();
  });
  
  document.getElementById('btn-hiit-pause')?.addEventListener('click', () => {
    hiitState.status = 'paused';
    clearInterval(hiitState.timerId);
    render();
  });
  
  document.getElementById('btn-hiit-resume')?.addEventListener('click', () => {
    initAudio();
    hiitState.status = 'running';
    hiitState.timerId = setInterval(hiitTick, 1000);
    render();
  });
  
  document.getElementById('btn-hiit-reset')?.addEventListener('click', () => {
    clearInterval(hiitState.timerId);
    hiitState.status = 'idle';
    hiitState.phase = 'work';
    hiitState.timeLeft = 20;
    hiitState.currentSet = 1;
    render();
  });

  // ── Data Transfer (Export/Import)
  document.getElementById('btn-export')?.addEventListener('click', () => {
    const backupData = { exercises, logs, totalWeight };
    const blob = new Blob([JSON.stringify(backupData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ironlog_backup_${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('⬆️ データをエクスポートしました');
  });

  document.getElementById('import-file-input')?.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (evt) => {
      try {
        const data = JSON.parse(evt.target.result);
        if (data.exercises && data.logs && typeof data.totalWeight === 'number') {
          exercises = data.exercises;
          logs = data.logs;
          totalWeight = data.totalWeight;

          saveExercises();
          saveLogs();
          saveTotalWeight();

          showToast('⬇️ データをインポートしました');
          render();
        } else {
          showToast('⚠️ 無効なファイル形式です');
        }
      } catch {
        showToast('⚠️ ファイルの読み込みに失敗しました');
      }
    };
    reader.readAsText(file);
  });

  // ── Exercise card delegation
  content.addEventListener('click', (e) => {
    // Move up
    const moveUpBtn = e.target.closest('[data-move-up]');
    if (moveUpBtn) {
      const id = +moveUpBtn.dataset.moveUp;
      const idx = exercises.findIndex(x => x.id === id);
      if (idx > 0) {
        [exercises[idx - 1], exercises[idx]] = [exercises[idx], exercises[idx - 1]];
        saveExercises();
        renderExList();
      }
      return;
    }

    // Move down
    const moveDownBtn = e.target.closest('[data-move-down]');
    if (moveDownBtn) {
      const id = +moveDownBtn.dataset.moveDown;
      const idx = exercises.findIndex(x => x.id === id);
      if (idx >= 0 && idx < exercises.length - 1) {
        [exercises[idx], exercises[idx + 1]] = [exercises[idx + 1], exercises[idx]];
        saveExercises();
        renderExList();
      }
      return;
    }

    // Toggle open/close
    const toggleBtn = e.target.closest('[data-toggle]');
    if (toggleBtn) {
      const id = +toggleBtn.dataset.toggle;
      if (!session[id]) session[id] = { sets: [], open: false };
      session[id].open = !session[id].open;
      renderExList();
      return;
    }

    // Edit exercise
    const editBtn = e.target.closest('[data-edit]');
    if (editBtn) {
      const ex = exercises.find(x => x.id === +editBtn.dataset.edit);
      if (ex) openModal(ex);
      return;
    }

    // Delete exercise
    const delBtn = e.target.closest('[data-delete]');
    if (delBtn) {
      const id = +delBtn.dataset.delete;
      if (!confirm('この種目を削除しますか？')) return;
      exercises = exercises.filter(x => x.id !== id);
      saveExercises();
      delete session[id];
      clearInterval(timerIntervals[id]);
      renderExList();
      return;
    }

    // Set tap
    const setTapBtn = e.target.closest('[data-set-tap]');
    if (setTapBtn) {
      const id = +setTapBtn.dataset.setTap;
      if (!session[id]) session[id] = { sets: [], open: true };
      session[id].sets.push({ time: nowHHMM() });

      // Ripple effect
      const rect = setTapBtn.getBoundingClientRect();
      const ripple = document.createElement('div');
      ripple.className = 'ripple';
      const x = (e.clientX || rect.left + rect.width/2) - rect.left - 20;
      const y = (e.clientY || rect.top + rect.height/2) - rect.top - 20;
      ripple.style.left = x + 'px';
      ripple.style.top = y + 'px';
      setTapBtn.appendChild(ripple);
      setTimeout(() => ripple.remove(), 500);

      renderExList();
      return;
    }

    // Undo last set
    const undoBtn = e.target.closest('[data-undo]');
    if (undoBtn) {
      const id = +undoBtn.dataset.undo;
      if (session[id]?.sets?.length > 0) {
        session[id].sets.pop();
        renderExList();
        showToast('↩ 最後のセットを取り消しました');
      }
      return;
    }

    // Timer start
    const tsBtn = e.target.closest('[data-timer-start]');
    if (tsBtn && !tsBtn.id.includes('hiit')) { timerStart(+tsBtn.dataset.timerStart); return; }

    // Timer stop
    const tStopBtn = e.target.closest('[data-timer-stop]');
    if (tStopBtn && !tStopBtn.id.includes('hiit')) { timerStop(+tStopBtn.dataset.timerStop); return; }

    // Timer reset
    const tResetBtn = e.target.closest('[data-timer-reset]');
    if (tResetBtn && !tResetBtn.id.includes('hiit')) { timerReset(+tResetBtn.dataset.timerReset); return; }

    // Timer mode
    const tModeBtn = e.target.closest('[data-timer-mode]');
    if (tModeBtn) {
      const id = +tModeBtn.dataset.timerMode;
      const mode = tModeBtn.dataset.mode;
      timerStop(id);
      const t = getOrInitTimer(id);
      t.mode = mode;
      t.cur = mode === 'countdown' ? t.preset : 0;
      renderExList();
      return;
    }

    // Timer preset
    const tPresetBtn = e.target.closest('[data-timer-preset]');
    if (tPresetBtn) {
      const id = +tPresetBtn.dataset.timerPreset;
      const sec = +tPresetBtn.dataset.sec;
      timerStop(id);
      const t = getOrInitTimer(id);
      t.preset = sec;
      t.cur = sec;
      renderExList();
      return;
    }
  });

  // Timer custom input
  content.addEventListener('change', (e) => {
    const customInput = e.target.closest('[data-timer-custom]');
    if (customInput) {
      const id = +customInput.dataset.timerCustom;
      const val = Math.max(10, Math.min(600, +customInput.value || 90));
      timerStop(id);
      const t = getOrInitTimer(id);
      t.preset = val;
      t.cur = val;
      renderExList();
    }
  });
}

// Partial re-render for workout list only
function renderExList() {
  const list = document.getElementById('ex-list');
  if (!list) return;
  list.innerHTML = exercises.map((ex, idx) => renderExCard(ex, idx)).join('');
}

// ── Save log ─────────────────────────────────────────────────────
function saveLog() {
  const entries = exercises
    .map(ex => {
      const s = session[ex.id];
      if (!s || s.sets.length === 0) return null;
      return { name: ex.name, weight: ex.weight, sets: s.sets.length };
    })
    .filter(Boolean);

  if (entries.length === 0) {
    showToast('⚠️ セット完了の種目がありません');
    return;
  }

  const dayTotal = entries.reduce((sum, e) => sum + e.weight * e.sets, 0);

  logs = [
    { date: todayStr(), entries, total: dayTotal },
    ...logs.filter(l => l.date !== todayStr())
  ];
  totalWeight += dayTotal;

  saveLogs();
  saveTotalWeight();

  session = {};
  Object.keys(timerIntervals).forEach(k => clearInterval(timerIntervals[k]));

  showToast(`✅ 保存完了！本日の総重量 ${dayTotal.toLocaleString()} kg`);
  render();
}

// ================================================================
//  MODAL (Add / Edit)
// ================================================================
function openModal(ex = null) {
  const isEdit = !!ex;
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-sheet">
      <div class="modal-pill"></div>
      <div class="modal-title">${isEdit ? '種目を編集' : '種目を追加'}</div>

      <label class="form-label">種目名</label>
      <input class="form-input" id="modal-name" type="text"
        value="${isEdit ? ex.name : ''}" placeholder="例：ベンチプレス" />

      <label class="form-label">重量 (kg)</label>
      <input class="form-input" id="modal-weight" type="number"
        value="${isEdit ? ex.weight : 60}" min="0" step="0.5" />

      <div class="modal-btn-row">
        <button class="btn-cancel" id="modal-cancel">キャンセル</button>
        <button class="btn-confirm" id="modal-confirm">保存</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);
  document.getElementById('modal-name').focus();

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.remove();
  });

  document.getElementById('modal-cancel').addEventListener('click', () => overlay.remove());

  document.getElementById('modal-confirm').addEventListener('click', () => {
    const name   = document.getElementById('modal-name').value.trim();
    const weight = parseFloat(document.getElementById('modal-weight').value) || 0;
    if (!name) { showToast('⚠️ 種目名を入力してください'); return; }

    if (isEdit) {
      exercises = exercises.map(x => x.id === ex.id ? { ...x, name, weight } : x);
    } else {
      exercises.push({ id: uid(), name, weight });
    }
    saveExercises();
    overlay.remove();
    renderExList();
  });
}

// ================================================================
//  PWA SERVICE WORKER
// ================================================================
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js');
  });
}

// ================================================================
//  INIT
// ================================================================
render();