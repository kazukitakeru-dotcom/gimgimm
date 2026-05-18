import { useState, useEffect, useRef, useCallback } from "react";

// ────────────────────────────────────────────────────────────
// Persistent storage helpers
// ────────────────────────────────────────────────────────────
const STORAGE_KEYS = {
  exercises: "wt_exercises",
  logs: "wt_logs",
  totalWeight: "wt_total",
};

async function load(key) {
  try {
    const r = await window.storage.get(key);
    return r ? JSON.parse(r.value) : null;
  } catch {
    return null;
  }
}

async function save(key, value) {
  try {
    await window.storage.set(key, JSON.stringify(value));
  } catch (e) {
    console.error("storage error", e);
  }
}

// ────────────────────────────────────────────────────────────
// Utility
// ────────────────────────────────────────────────────────────
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

function formatTime(sec) {
  const m = Math.floor(sec / 60).toString().padStart(2, "0");
  const s = (sec % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

function nowHHMM() {
  const d = new Date();
  return `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
}

const DEFAULT_EXERCISES = [
  { id: 1, name: "ベンチプレス", weight: 60 },
  { id: 2, name: "スクワット", weight: 80 },
  { id: 3, name: "デッドリフト", weight: 100 },
];

// ────────────────────────────────────────────────────────────
// Sub-components
// ────────────────────────────────────────────────────────────

// Timer / Counter widget per exercise
function SetCounter({ exId, weight, onFinishSet }) {
  const [mode, setMode] = useState("timer"); // "timer" | "counter"
  const [timerSec, setTimerSec] = useState(60);
  const [timerInput, setTimerInput] = useState(60);
  const [running, setRunning] = useState(false);
  const [count, setCount] = useState(0);
  const [history, setHistory] = useState([]); // [{count/time, timestamp}]
  const intervalRef = useRef(null);

  const stop = useCallback(() => {
    clearInterval(intervalRef.current);
    setRunning(false);
  }, []);

  const startTimer = () => {
    if (timerSec <= 0) return;
    setRunning(true);
    intervalRef.current = setInterval(() => {
      setTimerSec((s) => {
        if (s <= 1) {
          clearInterval(intervalRef.current);
          setRunning(false);
          return 0;
        }
        return s - 1;
      });
    }, 1000);
  };

  const startCounter = () => {
    setRunning(true);
    setCount(0);
    intervalRef.current = setInterval(() => {
      setCount((c) => c + 1);
    }, 1000);
  };

  const handleStart = () => {
    if (mode === "timer") startTimer();
    else startCounter();
  };

  const handleStop = () => {
    stop();
    const val = mode === "timer" ? timerInput - timerSec : count;
    const entry = {
      id: Date.now(),
      value: mode === "timer" ? `${val}秒` : `${val}秒`,
      label: mode === "timer" ? `残${timerSec}秒` : `${count}秒`,
      time: nowHHMM(),
    };
    const newHistory = [...history, entry];
    setHistory(newHistory);
    onFinishSet(newHistory.length, newHistory[newHistory.length - 1].time);
    if (mode === "timer") setTimerSec(timerInput);
    if (mode === "counter") setCount(0);
  };

  const handleUndo = () => {
    if (history.length === 0) return;
    const newHistory = history.slice(0, -1);
    setHistory(newHistory);
    onFinishSet(newHistory.length, newHistory[newHistory.length - 1]?.time ?? null);
  };

  useEffect(() => () => clearInterval(intervalRef.current), []);

  const modeColor = mode === "timer" ? "#f97316" : "#22d3ee";

  return (
    <div style={styles.counterBox}>
      {/* Mode toggle */}
      <div style={styles.modeRow}>
        <button
          onClick={() => { stop(); setMode("timer"); setTimerSec(timerInput); setCount(0); }}
          style={{ ...styles.modeBtn, background: mode === "timer" ? "#f97316" : "rgba(255,255,255,0.08)", color: mode === "timer" ? "#000" : "#888" }}
        >⏳ タイマー</button>
        <button
          onClick={() => { stop(); setMode("counter"); setTimerSec(timerInput); setCount(0); }}
          style={{ ...styles.modeBtn, background: mode === "counter" ? "#22d3ee" : "rgba(255,255,255,0.08)", color: mode === "counter" ? "#000" : "#888" }}
        >🔢 カウント</button>
      </div>

      {/* Timer input */}
      {mode === "timer" && !running && (
        <div style={styles.timerInputRow}>
          <span style={styles.dimText}>設定秒数：</span>
          <input
            type="number"
            value={timerInput}
            min={5}
            max={600}
            onChange={(e) => { const v = Number(e.target.value); setTimerInput(v); setTimerSec(v); }}
            style={styles.numInput}
          />
          <span style={styles.dimText}>秒</span>
        </div>
      )}

      {/* Big display */}
      <div style={{ ...styles.bigDisplay, color: modeColor }}>
        {mode === "timer" ? formatTime(timerSec) : formatTime(count)}
      </div>

      {/* Controls */}
      <div style={styles.ctrlRow}>
        {!running ? (
          <button onClick={handleStart} style={{ ...styles.ctrlBtn, background: modeColor, color: "#000" }}>
            ▶ スタート
          </button>
        ) : (
          <button onClick={handleStop} style={{ ...styles.ctrlBtn, background: "#ef4444", color: "#fff" }}>
            ⏹ ストップ
          </button>
        )}
      </div>

      {/* History */}
      {history.length > 0 && (
        <div style={styles.historyBox}>
          {history.map((h, i) => (
            <div key={h.id} style={styles.historyRow}>
              <span style={styles.historySet}>Set {i + 1}</span>
              <span style={styles.historyVal}>{h.label}</span>
              <span style={styles.historyTime}>{h.time}</span>
            </div>
          ))}
          <button onClick={handleUndo} style={styles.undoBtn}>↩ 最後のセットを取り消し</button>
        </div>
      )}
    </div>
  );
}

// Exercise card
function ExerciseCard({ ex, onEdit, onDelete, onDragStart, onDrop, onSetUpdate }) {
  const [open, setOpen] = useState(false);
  const [sets, setSets] = useState(0);
  const [lastTime, setLastTime] = useState(null);

  const handleFinishSet = (newSets, time) => {
    setSets(newSets);
    setLastTime(time);
    onSetUpdate(ex.id, newSets, time);
  };

  return (
    <div
      draggable
      onDragStart={() => onDragStart(ex.id)}
      onDragOver={(e) => e.preventDefault()}
      onDrop={() => onDrop(ex.id)}
      style={styles.card}
    >
      <div style={styles.cardHeader}>
        <span style={styles.dragHandle}>⠿</span>
        <div style={styles.cardTitle}>
          <span style={styles.exName}>{ex.name}</span>
          <span style={styles.exWeight}>{ex.weight} kg</span>
        </div>
        <div style={styles.cardActions}>
          <button onClick={() => setOpen(!open)} style={styles.iconBtn}>{open ? "▲" : "▼"}</button>
          <button onClick={() => onEdit(ex)} style={styles.iconBtn}>✏️</button>
          <button onClick={() => onDelete(ex.id)} style={{ ...styles.iconBtn, color: "#ef4444" }}>🗑</button>
        </div>
      </div>
      {sets > 0 && (
        <div style={styles.setInfo}>
          <span style={{ color: "#a3e635" }}>✓ {sets} セット完了</span>
          {lastTime && <span style={styles.dimText}> {lastTime}</span>}
        </div>
      )}
      {open && <SetCounter exId={ex.id} weight={ex.weight} onFinishSet={handleFinishSet} />}
    </div>
  );
}

// ────────────────────────────────────────────────────────────
// Main App
// ────────────────────────────────────────────────────────────
export default function App() {
  const [tab, setTab] = useState("workout"); // "workout" | "log" | "stats"
  const [exercises, setExercises] = useState(DEFAULT_EXERCISES);
  const [logs, setLogs] = useState([]); // [{date, entries:[{name,weight,sets}], total}]
  const [totalWeight, setTotalWeight] = useState(0);
  const [loaded, setLoaded] = useState(false);

  // session sets: {exId: {sets, lastTime}}
  const sessionRef = useRef({});

  // modal state
  const [modal, setModal] = useState(null); // null | {type:"add"|"edit", ex?}
  const [formName, setFormName] = useState("");
  const [formWeight, setFormWeight] = useState(0);

  const [dragId, setDragId] = useState(null);

  // Load from storage
  useEffect(() => {
    (async () => {
      const ex = await load(STORAGE_KEYS.exercises);
      const lg = await load(STORAGE_KEYS.logs);
      const tw = await load(STORAGE_KEYS.totalWeight);
      if (ex) setExercises(ex);
      if (lg) setLogs(lg);
      if (tw !== null) setTotalWeight(tw);
      setLoaded(true);
    })();
  }, []);

  const persistExercises = (data) => { setExercises(data); save(STORAGE_KEYS.exercises, data); };
  const persistLogs = (data) => { setLogs(data); save(STORAGE_KEYS.logs, data); };
  const persistTotal = (val) => { setTotalWeight(val); save(STORAGE_KEYS.totalWeight, val); };

  // Called when a set counter updates
  const handleSetUpdate = (exId, sets, time) => {
    sessionRef.current[exId] = { sets, time };
  };

  // Save today's log
  const saveLog = () => {
    const entries = exercises
      .map((ex) => {
        const s = sessionRef.current[ex.id];
        if (!s || s.sets === 0) return null;
        return { name: ex.name, weight: ex.weight, sets: s.sets };
      })
      .filter(Boolean);

    if (entries.length === 0) { alert("セット完了の種目がありません"); return; }

    const dayTotal = entries.reduce((sum, e) => sum + e.weight * e.sets, 0);
    const newLog = { date: todayStr(), entries, total: dayTotal };
    const newLogs = [newLog, ...logs.filter((l) => l.date !== todayStr())];
    const newTotal = totalWeight + dayTotal;
    persistLogs(newLogs);
    persistTotal(newTotal);
    sessionRef.current = {};
    alert(`✅ ${todayStr()} のログを保存しました\n本日の総重量: ${dayTotal.toLocaleString()} kg`);
  };

  // Exercise CRUD
  const openAdd = () => { setFormName(""); setFormWeight(60); setModal({ type: "add" }); };
  const openEdit = (ex) => { setFormName(ex.name); setFormWeight(ex.weight); setModal({ type: "edit", ex }); };
  const submitModal = () => {
    if (!formName.trim()) return;
    if (modal.type === "add") {
      const next = [...exercises, { id: Date.now(), name: formName.trim(), weight: Number(formWeight) }];
      persistExercises(next);
    } else {
      const next = exercises.map((e) => e.id === modal.ex.id ? { ...e, name: formName.trim(), weight: Number(formWeight) } : e);
      persistExercises(next);
    }
    setModal(null);
  };
  const deleteEx = (id) => {
    if (!confirm("削除しますか？")) return;
    persistExercises(exercises.filter((e) => e.id !== id));
  };

  // Drag & drop reorder
  const handleDrop = (targetId) => {
    if (dragId === targetId) return;
    const from = exercises.findIndex((e) => e.id === dragId);
    const to = exercises.findIndex((e) => e.id === targetId);
    const next = [...exercises];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    persistExercises(next);
    setDragId(null);
  };

  if (!loaded) return <div style={styles.loading}>Loading…</div>;

  return (
    <div style={styles.root}>
      {/* Header */}
      <header style={styles.header}>
        <h1 style={styles.appTitle}>💪 IRON LOG</h1>
        <p style={styles.appSub}>{todayStr()}</p>
      </header>

      {/* Tab bar */}
      <nav style={styles.tabBar}>
        {[["workout", "🏋️ トレーニング"], ["log", "📅 ログ"], ["stats", "📊 統計"]].map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            style={{ ...styles.tabBtn, ...(tab === key ? styles.tabBtnActive : {}) }}
          >{label}</button>
        ))}
      </nav>

      {/* ── Workout tab ── */}
      {tab === "workout" && (
        <div style={styles.content}>
          <button onClick={openAdd} style={styles.addBtn}>＋ 種目を追加</button>
          {exercises.map((ex) => (
            <ExerciseCard
              key={ex.id}
              ex={ex}
              onEdit={openEdit}
              onDelete={deleteEx}
              onDragStart={setDragId}
              onDrop={handleDrop}
              onSetUpdate={handleSetUpdate}
            />
          ))}
          <button onClick={saveLog} style={styles.saveBtn}>💾 今日のログを保存</button>
        </div>
      )}

      {/* ── Log tab ── */}
      {tab === "log" && (
        <div style={styles.content}>
          {logs.length === 0 && <p style={styles.dimText}>まだログがありません</p>}
          {logs.map((log, i) => (
            <div key={i} style={styles.logCard}>
              <div style={styles.logDate}>{log.date}</div>
              {log.entries.map((e, j) => (
                <div key={j} style={styles.logEntry}>
                  <span style={styles.logName}>{e.name}</span>
                  <span style={styles.logDetail}>{e.weight}kg × {e.sets}set</span>
                  <span style={styles.logSub}>{(e.weight * e.sets).toLocaleString()}kg</span>
                </div>
              ))}
              <div style={styles.logTotal}>本日の総重量：<strong style={{ color: "#a3e635" }}>{log.total.toLocaleString()} kg</strong></div>
            </div>
          ))}
        </div>
      )}

      {/* ── Stats tab ── */}
      {tab === "stats" && (
        <div style={styles.content}>
          <div style={styles.statCard}>
            <div style={styles.statLabel}>累計扱った重量</div>
            <div style={styles.statValue}>{totalWeight.toLocaleString()} <span style={styles.statUnit}>kg</span></div>
          </div>
          <div style={styles.statCard}>
            <div style={styles.statLabel}>記録日数</div>
            <div style={styles.statValue}>{logs.length} <span style={styles.statUnit}>日</span></div>
          </div>
          <div style={styles.statCard}>
            <div style={styles.statLabel}>平均 / 日</div>
            <div style={styles.statValue}>
              {logs.length > 0 ? Math.round(totalWeight / logs.length).toLocaleString() : 0}
              <span style={styles.statUnit}> kg</span>
            </div>
          </div>
          {logs.length > 0 && (
            <div style={{ marginTop: 24 }}>
              <p style={{ ...styles.dimText, marginBottom: 8 }}>直近5回の総重量推移</p>
              {[...logs].slice(0, 5).reverse().map((log, i) => (
                <div key={i} style={styles.barRow}>
                  <span style={styles.barLabel}>{log.date.replace(/\d{4}年/, "")}</span>
                  <div style={styles.barTrack}>
                    <div style={{
                      ...styles.barFill,
                      width: `${Math.min(100, (log.total / Math.max(...logs.slice(0, 5).map(l => l.total))) * 100)}%`
                    }} />
                  </div>
                  <span style={styles.barVal}>{log.total.toLocaleString()}kg</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Modal ── */}
      {modal && (
        <div style={styles.overlay} onClick={() => setModal(null)}>
          <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
            <h2 style={styles.modalTitle}>{modal.type === "add" ? "種目を追加" : "種目を編集"}</h2>
            <label style={styles.label}>種目名</label>
            <input
              style={styles.input}
              value={formName}
              onChange={(e) => setFormName(e.target.value)}
              placeholder="例：ベンチプレス"
            />
            <label style={styles.label}>重量 (kg)</label>
            <input
              style={styles.input}
              type="number"
              value={formWeight}
              min={0}
              step={0.5}
              onChange={(e) => setFormWeight(e.target.value)}
            />
            <div style={styles.modalBtns}>
              <button onClick={() => setModal(null)} style={styles.cancelBtn}>キャンセル</button>
              <button onClick={submitModal} style={styles.confirmBtn}>保存</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────
// Styles
// ────────────────────────────────────────────────────────────
const styles = {
  root: {
    minHeight: "100vh",
    background: "#0a0a0f",
    color: "#e5e5e5",
    fontFamily: "'Hiragino Sans', 'Noto Sans JP', sans-serif",
    maxWidth: 480,
    margin: "0 auto",
    paddingBottom: 40,
  },
  loading: { color: "#888", padding: 40, textAlign: "center" },
  header: {
    padding: "24px 20px 12px",
    borderBottom: "1px solid rgba(255,255,255,0.06)",
  },
  appTitle: {
    margin: 0,
    fontSize: 28,
    fontWeight: 900,
    letterSpacing: 3,
    background: "linear-gradient(90deg,#f97316,#facc15)",
    WebkitBackgroundClip: "text",
    WebkitTextFillColor: "transparent",
  },
  appSub: { margin: "4px 0 0", fontSize: 13, color: "#666" },
  tabBar: {
    display: "flex",
    borderBottom: "1px solid rgba(255,255,255,0.06)",
    background: "#0f0f18",
    position: "sticky",
    top: 0,
    zIndex: 10,
  },
  tabBtn: {
    flex: 1,
    padding: "14px 4px",
    background: "none",
    border: "none",
    color: "#555",
    fontSize: 13,
    cursor: "pointer",
    fontFamily: "inherit",
    transition: "color 0.2s",
  },
  tabBtnActive: {
    color: "#f97316",
    borderBottom: "2px solid #f97316",
  },
  content: { padding: "16px 16px 0" },
  addBtn: {
    width: "100%",
    padding: "12px",
    marginBottom: 12,
    background: "rgba(249,115,22,0.12)",
    border: "1px dashed #f97316",
    borderRadius: 10,
    color: "#f97316",
    fontSize: 15,
    cursor: "pointer",
    fontFamily: "inherit",
  },
  saveBtn: {
    width: "100%",
    padding: "14px",
    marginTop: 20,
    background: "linear-gradient(90deg,#f97316,#facc15)",
    border: "none",
    borderRadius: 12,
    color: "#000",
    fontSize: 16,
    fontWeight: 700,
    cursor: "pointer",
    fontFamily: "inherit",
  },
  card: {
    background: "#13131e",
    border: "1px solid rgba(255,255,255,0.07)",
    borderRadius: 14,
    marginBottom: 12,
    overflow: "hidden",
    cursor: "grab",
  },
  cardHeader: {
    display: "flex",
    alignItems: "center",
    padding: "14px 12px",
    gap: 8,
  },
  dragHandle: { fontSize: 18, color: "#444", cursor: "grab", userSelect: "none" },
  cardTitle: { flex: 1 },
  exName: { display: "block", fontWeight: 700, fontSize: 16 },
  exWeight: { display: "block", fontSize: 13, color: "#f97316", marginTop: 2 },
  cardActions: { display: "flex", gap: 4 },
  iconBtn: {
    background: "none",
    border: "none",
    fontSize: 16,
    cursor: "pointer",
    padding: "4px 6px",
    borderRadius: 6,
    color: "#aaa",
  },
  setInfo: { padding: "0 14px 10px", fontSize: 13 },
  counterBox: {
    padding: "0 14px 16px",
    borderTop: "1px solid rgba(255,255,255,0.05)",
  },
  modeRow: { display: "flex", gap: 8, marginTop: 12, marginBottom: 12 },
  modeBtn: {
    flex: 1,
    padding: "8px",
    border: "none",
    borderRadius: 8,
    fontSize: 13,
    cursor: "pointer",
    fontFamily: "inherit",
    fontWeight: 600,
    transition: "all 0.2s",
  },
  timerInputRow: { display: "flex", alignItems: "center", gap: 6, marginBottom: 8 },
  numInput: {
    width: 64,
    padding: "6px 8px",
    background: "#1e1e2e",
    border: "1px solid #333",
    borderRadius: 8,
    color: "#fff",
    fontSize: 15,
    textAlign: "center",
  },
  bigDisplay: {
    fontSize: 52,
    fontWeight: 900,
    textAlign: "center",
    fontVariantNumeric: "tabular-nums",
    letterSpacing: 4,
    margin: "8px 0",
  },
  ctrlRow: { display: "flex", justifyContent: "center", marginBottom: 12 },
  ctrlBtn: {
    padding: "12px 40px",
    borderRadius: 100,
    border: "none",
    fontSize: 16,
    fontWeight: 700,
    cursor: "pointer",
    fontFamily: "inherit",
  },
  historyBox: {
    background: "rgba(255,255,255,0.03)",
    borderRadius: 10,
    padding: "10px 12px",
    marginTop: 4,
  },
  historyRow: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "4px 0",
    borderBottom: "1px solid rgba(255,255,255,0.04)",
  },
  historySet: { fontSize: 12, color: "#888", width: 44 },
  historyVal: { fontSize: 14, color: "#e5e5e5", flex: 1 },
  historyTime: { fontSize: 12, color: "#555" },
  undoBtn: {
    marginTop: 8,
    background: "none",
    border: "1px solid #ef4444",
    borderRadius: 8,
    color: "#ef4444",
    fontSize: 12,
    padding: "6px 12px",
    cursor: "pointer",
    fontFamily: "inherit",
    width: "100%",
  },
  logCard: {
    background: "#13131e",
    border: "1px solid rgba(255,255,255,0.07)",
    borderRadius: 14,
    padding: "14px 16px",
    marginBottom: 12,
  },
  logDate: { fontWeight: 700, fontSize: 15, marginBottom: 10, color: "#facc15" },
  logEntry: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "5px 0",
    borderBottom: "1px solid rgba(255,255,255,0.04)",
  },
  logName: { flex: 1, fontSize: 14 },
  logDetail: { fontSize: 13, color: "#aaa" },
  logSub: { fontSize: 12, color: "#555", width: 70, textAlign: "right" },
  logTotal: { marginTop: 10, fontSize: 14, textAlign: "right" },
  statCard: {
    background: "#13131e",
    border: "1px solid rgba(255,255,255,0.07)",
    borderRadius: 14,
    padding: "18px 20px",
    marginBottom: 12,
  },
  statLabel: { fontSize: 13, color: "#666", marginBottom: 6 },
  statValue: { fontSize: 40, fontWeight: 900, color: "#a3e635" },
  statUnit: { fontSize: 18, color: "#666" },
  barRow: { display: "flex", alignItems: "center", gap: 10, marginBottom: 8 },
  barLabel: { fontSize: 12, color: "#888", width: 58, textAlign: "right" },
  barTrack: { flex: 1, height: 8, background: "#1e1e2e", borderRadius: 99, overflow: "hidden" },
  barFill: { height: "100%", background: "linear-gradient(90deg,#f97316,#facc15)", borderRadius: 99, transition: "width 0.4s" },
  barVal: { fontSize: 12, color: "#aaa", width: 70, textAlign: "right" },
  overlay: {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,0.7)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 100,
    padding: 20,
  },
  modal: {
    background: "#13131e",
    border: "1px solid rgba(255,255,255,0.1)",
    borderRadius: 18,
    padding: 24,
    width: "100%",
    maxWidth: 360,
  },
  modalTitle: { margin: "0 0 20px", fontSize: 18, fontWeight: 700 },
  label: { display: "block", fontSize: 12, color: "#888", marginBottom: 6 },
  input: {
    display: "block",
    width: "100%",
    padding: "12px 14px",
    marginBottom: 16,
    background: "#0f0f18",
    border: "1px solid #2a2a3a",
    borderRadius: 10,
    color: "#fff",
    fontSize: 16,
    fontFamily: "inherit",
    boxSizing: "border-box",
  },
  modalBtns: { display: "flex", gap: 10, marginTop: 4 },
  cancelBtn: {
    flex: 1,
    padding: "12px",
    background: "none",
    border: "1px solid #333",
    borderRadius: 10,
    color: "#aaa",
    fontSize: 15,
    cursor: "pointer",
    fontFamily: "inherit",
  },
  confirmBtn: {
    flex: 1,
    padding: "12px",
    background: "linear-gradient(90deg,#f97316,#facc15)",
    border: "none",
    borderRadius: 10,
    color: "#000",
    fontSize: 15,
    fontWeight: 700,
    cursor: "pointer",
    fontFamily: "inherit",
  },
  dimText: { color: "#555", fontSize: 13 },
};
