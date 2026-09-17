'use strict';
/* ============================================================================
   IRON LOG — 記録をAIに貼れるテキストにして書き出す

   ログ画面から
     セッション1件      … 🤖 ボタンで即コピー
     その日ぶん         … 日付の横の 🤖 ボタンで即コピー
     まとめて           … 上部のボタンから範囲と内容を選んでコピー

   数字だけ渡してもAIが読み違えるので、
   「総重量＝各セットの重量の合計」「レップ数は記録していない」といった
   読み方の説明を必ず先頭に入れる。
   ========================================================================== */

const AI_LEAD = 'これは私の筋トレの記録です。内容を踏まえたうえで質問に答えてください。';

/* ── 小道具 ───────────────────────────────────────────────────────────── */
function aiNum(n) { return Math.round(Number(n) || 0).toLocaleString('en-US'); }

function aiDateLabel(iso) {
  const H = window.IRONLOG.helpers;
  return `${iso} (${H.isoWeekday(iso)})`;
}

/* 日付ごとに筋トレ・有酸素をまとめる（古い順の日付配列も返す） */
function aiGroupByDate(logs, cardioLogs) {
  const days = {};
  const day = d => (days[d] = days[d] || { date: d, workouts: [], cardio: [], total: 0 });
  [...logs].reverse().forEach(l => { const x = day(l.date); x.workouts.push(l); x.total += (l.total || 0); });
  [...cardioLogs].reverse().forEach(c => day(c.date).cardio.push(c));
  Object.values(days).forEach(d => {
    d.workouts.sort((a, b) => (a.time || '').localeCompare(b.time || ''));
    d.cardio.sort((a, b) => (a.time || '').localeCompare(b.time || ''));
  });
  return { days, dates: Object.keys(days).sort() };
}

/* ── 1セッションぶんの本文 ────────────────────────────────────────────── */
function aiSessionLines(log, index, count) {
  const H = window.IRONLOG.helpers;
  const L = [];
  const head = count > 1 ? `${log.time || '時刻不明'}（${index + 1}回目）` : (log.time || '時刻不明');
  L.push(`- ${head} 合計 ${aiNum(log.total)}kg`);

  (log.entries || []).forEach(e => {
    L.push(`  - ${e.name} ${H.entryWeightLabel(e)} × ${e.sets}セット = ${aiNum(e.total)}kg`);
    // セットごとに重量が違うときだけ内訳を出す
    const ws = (e.setList || []).map(s => s.weight).filter(w => typeof w === 'number');
    if (ws.length && new Set(ws).size > 1) {
      L.push(`    内訳: ${e.setList.map((s, i) => `${i + 1}セット目 ${s.weight}kg`).join(' / ')}`);
    }
  });
  return L;
}

function aiCardioLine(c) {
  const H = window.IRONLOG.helpers;
  const type = c.mode === 'sprint' ? 'ダッシュ'
    : c.type === 'run' ? 'ランニング' : c.type === 'walk' ? 'ウォーキング' : 'バイク';
  return `- 有酸素 ${c.time || '時刻不明'} ${type} ${H.cardioDetail(c)}${c.notes ? `（メモ: ${c.notes}）` : ''}`;
}

/* ── 種目の設定 ───────────────────────────────────────────────────────── */
function aiExerciseSection() {
  const ex = window.IRONLOG.getExercises();
  const st = window.IRONLOG.getSettings();
  if (!ex.length) return [];

  const L = ['## いまの種目の設定', ''];
  L.push('| 種目 | 重量 | 目標セット | レスト | 自重 |');
  L.push('| --- | ---: | ---: | ---: | --- |');
  ex.forEach(x => {
    const rest = typeof x.restSec === 'number' ? `${x.restSec}秒` : `${st.defaultRestSec}秒（共通）`;
    const bw   = x.bodyweight ? `体重×${x.bwRatio ?? 100}%` : '—';
    const w    = x.bodyweight ? (x.weight ? `＋${x.weight}kg` : 'なし') : `${x.weight}kg`;
    L.push(`| ${x.name}${x.benched ? '（補欠・今は休止中）' : ''} | ${w} | ${x.targetSets || 3} | ${rest} | ${bw} |`);
  });
  L.push('');
  return L;
}

/* ── 本文を組み立てる ─────────────────────────────────────────────────── */
function buildAiText(opts) {
  const o = Object.assign(
    { logs: [], cardio: [], withLead: true, withExercises: true, title: '筋トレ記録' },
    opts || {}
  );
  const H  = window.IRONLOG.helpers;
  const st = window.IRONLOG.getSettings();
  const { days, dates } = aiGroupByDate(o.logs, o.cardio);
  const total = o.logs.reduce((s, l) => s + (l.total || 0), 0);
  const L = [];

  if (o.withLead) { L.push(AI_LEAD); L.push(''); }

  L.push(`# ${o.title}`);
  L.push('');
  if (dates.length) {
    L.push(`期間: ${aiDateLabel(dates[0])} 〜 ${aiDateLabel(dates[dates.length - 1])}`);
  }
  L.push(`記録日数: ${new Set(o.logs.map(l => l.date)).size}日 / セッション: ${o.logs.length}回`);
  L.push(`総重量: ${aiNum(total)}kg`);
  if (st.bodyWeight) L.push(`体重: ${st.bodyWeight}kg`);
  L.push('');

  L.push('読み方');
  L.push('- 「総重量」は各セットで扱った重量の合計です。**挙上回数（レップ数）は記録していません。**');
  L.push('- 自重種目（懸垂・腕立てなど）の重量は「体重×割合＋追加のオモリ」で、すでに合計に含まれています。');
  L.push('- 同じ日に複数のセッションがある場合は分けて書いてあります。');
  L.push('');

  if (o.withExercises) L.push(...aiExerciseSection());

  L.push('## 記録');
  L.push('');
  if (!dates.length) {
    L.push('（この期間の記録はありません）');
  } else {
    // 新しい日が上に来たほうがAIも人も読みやすい
    [...dates].reverse().forEach(d => {
      const day = days[d];
      L.push(`### ${aiDateLabel(d)}${day.total ? ` 合計 ${aiNum(day.total)}kg` : ''}`);
      day.workouts.forEach((log, i) => L.push(...aiSessionLines(log, i, day.workouts.length)));
      day.cardio.forEach(c => L.push(aiCardioLine(c)));
      L.push('');
    });
  }
  return L.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

/* ── クリップボード ───────────────────────────────────────────────────── */
async function aiCopyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (e) { /* 続けてフォールバックを試す */ }

  // iOS Safari 用のフォールバック。画面外の textarea を選択してコピーする
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch (e) { return false; }
}

/* コピーできなかったときに、手で選べる形で出す */
function aiShowTextModal(text) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-sheet">
      <div class="modal-pill"></div>
      <div class="modal-title">コピーできませんでした</div>
      <div class="setting-help">
        下の枠を長押し →「すべてを選択」→「コピー」で取り出せます。
      </div>
      <textarea class="ai-text-area" id="ai-text-area" readonly></textarea>
      <div class="modal-btn-row">
        <button class="btn-confirm" data-ai-close="1">閉じる</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('#ai-text-area').value = text;
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay || e.target.closest('[data-ai-close]')) overlay.remove();
  });
}

async function aiCopyAndReport(text, label) {
  const H = window.IRONLOG.helpers;
  const ok = await aiCopyText(text);
  if (ok) H.showToast(`📋 ${label}をコピーしました（${text.length.toLocaleString()}文字）`);
  else aiShowTextModal(text);
}

/* ── 画面から呼ぶ入口 ─────────────────────────────────────────────────── */

/* セッション1件 */
function aiCopySession(logId) {
  const log = window.IRONLOG.getLogs().find(l => String(l.id) === String(logId));
  if (!log) return;
  const H = window.IRONLOG.helpers;
  aiCopyAndReport(
    buildAiText({ logs: [log], cardio: [], withExercises: false, title: `筋トレ記録 ${H.jpDate(log.date)}` }),
    'この記録'
  );
}

/* その日ぶん（筋トレ＋有酸素） */
function aiCopyDay(date) {
  const H = window.IRONLOG.helpers;
  const logs   = window.IRONLOG.getLogs().filter(l => l.date === date);
  const cardio = window.IRONLOG.getCardioLogs().filter(c => c.date === date);
  if (!logs.length && !cardio.length) return;
  aiCopyAndReport(
    buildAiText({ logs, cardio, withExercises: false, title: `筋トレ記録 ${H.jpDate(date)}` }),
    `${H.jpDate(date)}の記録`
  );
}

/* まとめて（範囲と内容を選ぶ） */
function openAiCopyModal() {
  const H = window.IRONLOG.helpers;
  const allLogs   = window.IRONLOG.getLogs();
  const allCardio = window.IRONLOG.getCardioLogs();

  if (!allLogs.length && !allCardio.length) {
    H.showToast('⚠️ コピーできる記録がありません');
    return;
  }

  const RANGES = [
    { key: '7',   label: '直近7日' },
    { key: '30',  label: '直近30日' },
    { key: '90',  label: '直近3か月' },
    { key: 'all', label: 'すべて' },
  ];

  const st = { range: '30', withLead: true, withExercises: true, withCardio: true };

  function since(key) {
    if (key === 'all') return '0000-00-00';
    const d = new Date();
    d.setDate(d.getDate() - (+key - 1));
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  }

  function currentText() {
    const from = since(st.range);
    return buildAiText({
      logs:   allLogs.filter(l => l.date >= from),
      cardio: st.withCardio ? allCardio.filter(c => c.date >= from) : [],
      withLead: st.withLead,
      withExercises: st.withExercises,
    });
  }

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  document.body.appendChild(overlay);

  function paint() {
    const text = currentText();
    const from = since(st.range);
    const n    = allLogs.filter(l => l.date >= from).length;
    overlay.innerHTML = `
      <div class="modal-sheet">
        <div class="modal-pill"></div>
        <div class="modal-title">AIに貼る用にコピー</div>
        <div class="setting-help">
          記録を、AIが読み取れる形のテキストにして書き出します。
          「総重量にレップ数が入っていない」といった注意書きも一緒に入ります。
        </div>

        <label class="form-label">範囲</label>
        <div class="timer-presets">
          ${RANGES.map(r => `
            <button class="btn-preset${st.range === r.key ? ' selected' : ''}" data-ai-range="${r.key}">${r.label}</button>
          `).join('')}
        </div>

        <label class="form-label">含めるもの</label>
        <div class="ai-opt-list">
          <button class="ai-opt${st.withLead ? ' on' : ''}" data-ai-opt="withLead">
            <span class="ai-opt-box">${st.withLead ? '✓' : ''}</span>
            <span>AIへの前置き文<span class="ai-opt-sub">「これは私の筋トレの記録です…」</span></span>
          </button>
          <button class="ai-opt${st.withExercises ? ' on' : ''}" data-ai-opt="withExercises">
            <span class="ai-opt-box">${st.withExercises ? '✓' : ''}</span>
            <span>いまの種目の設定<span class="ai-opt-sub">重量・目標セット・レスト・自重</span></span>
          </button>
          <button class="ai-opt${st.withCardio ? ' on' : ''}" data-ai-opt="withCardio">
            <span class="ai-opt-box">${st.withCardio ? '✓' : ''}</span>
            <span>有酸素の記録</span>
          </button>
        </div>

        <div class="ai-count">セッション ${n}件 ／ ${text.length.toLocaleString()}文字</div>
        <textarea class="ai-text-area" id="ai-preview" readonly></textarea>

        <div class="modal-btn-row">
          <button class="btn-cancel" data-ai-close="1">閉じる</button>
          <button class="btn-confirm" data-ai-do-copy="1">コピー</button>
        </div>
        ${navigator.share ? `
          <button class="btn-export" data-ai-share="1" style="margin-top:10px">
            <span class="transfer-btn-icon">📤</span>共有（他のアプリに送る）
          </button>` : ''}
      </div>`;
    overlay.querySelector('#ai-preview').value = text;
  }

  paint();

  overlay.addEventListener('click', async (e) => {
    if (e.target === overlay) { overlay.remove(); return; }

    const rangeBtn = e.target.closest('[data-ai-range]');
    if (rangeBtn) { st.range = rangeBtn.dataset.aiRange; paint(); return; }

    const optBtn = e.target.closest('[data-ai-opt]');
    if (optBtn) { st[optBtn.dataset.aiOpt] = !st[optBtn.dataset.aiOpt]; paint(); return; }

    if (e.target.closest('[data-ai-close]')) { overlay.remove(); return; }

    if (e.target.closest('[data-ai-do-copy]')) {
      const text = currentText();
      overlay.remove();
      await aiCopyAndReport(text, '記録');
      return;
    }

    if (e.target.closest('[data-ai-share]')) {
      const text = currentText();
      try {
        await navigator.share({ text, title: 'IRON LOG の記録' });
        overlay.remove();
      } catch (err) {
        if (!err || err.name !== 'AbortError') H.showToast('⚠️ 共有できませんでした');
      }
      return;
    }
  });
}
