'use strict';
/* ============================================================================
   IRON LOG — Obsidian 書き出し

   書き出すノート
     筋トレ.md              … サマリー（累計・種目別・月別・最近の記録）
     日別/2026-08-05.md      … その日の全セッション（筋トレ＋有酸素）
     種目別/ベンチプレス.md   … 種目ごとの推移と全履歴

   3つのモード
     all    … 上の一式を ZIP で
     daily  … 日別ノートだけを ZIP で
     single … 全部を1枚の .md にまとめて

   app.js の state には window.IRONLOG 経由で触る。
   ========================================================================== */

const OBS_FOLDER = '筋トレ';
const OBS_DAILY  = '日別';
const OBS_EX     = '種目別';

/* ── 小道具 ───────────────────────────────────────────────────────────── */
function obsFileName(name) {
  return String(name || '無題')
    .replace(/[\\\/:*?"<>|#^\[\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || '無題';
}

function yamlStr(v) {
  const s = String(v == null ? '' : v);
  if (s === '') return '""';
  if (/^[-?:,\[\]{}#&*!|>'"%@`]|[:#]\s|\s$|^\s|^(true|false|null|yes|no|on|off)$/i.test(s) || /^[\d.+-]+$/.test(s)) {
    return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  }
  return s;
}

function cell(v) {
  return String(v == null ? '' : v).replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
}

function kg(n) { return Number(n || 0).toLocaleString('ja-JP') + ' kg'; }
function pct(part, whole) { return whole > 0 ? ((part / whole) * 100).toFixed(1) + '%' : '—'; }

/* ── 集計 ─────────────────────────────────────────────────────────────── */

/* 日付ごとに筋トレ・有酸素をまとめる（新しい順の日付配列も返す） */
function groupByDate(logs, cardioLogs) {
  const days = {};
  const day = d => (days[d] = days[d] || { date: d, workouts: [], cardio: [], total: 0 });
  // logs は新しい順で渡ってくるので、1日の中は逆順にして古い順に並べ直す
  [...logs].reverse().forEach(l => { const d = day(l.date); d.workouts.push(l); d.total += (l.total || 0); });
  [...cardioLogs].reverse().forEach(c => day(c.date).cardio.push(c));
  Object.values(days).forEach(d => {
    d.workouts.sort((a, b) => (a.time || '').localeCompare(b.time || ''));
    d.cardio.sort((a, b) => (a.time || '').localeCompare(b.time || ''));
  });
  return { days, dates: Object.keys(days).sort().reverse() };
}

/* 種目ごとの集計。ログに残っている名前で束ねる（削除済みの種目も履歴に残す） */
function byExercise(logs) {
  const H = window.IRONLOG.helpers;
  const map = {};
  logs.forEach(log => {
    (log.entries || []).forEach(e => {
      const m = map[e.name] = map[e.name] || {
        name: e.name, total: 0, sets: 0, sessions: 0, maxWeight: 0,
        first: log.date, last: log.date, history: [],
      };
      m.total    += e.total || 0;
      m.sets     += e.sets || 0;
      m.sessions += 1;
      const ws = (e.setList || []).map(s => s.weight).filter(w => typeof w === 'number');
      const w  = ws.length ? Math.max(...ws) : (e.sets ? (e.total || 0) / e.sets : 0);
      if (w > m.maxWeight) m.maxWeight = Math.round(w * 10) / 10;
      if (log.date < m.first) m.first = log.date;
      if (log.date > m.last)  m.last  = log.date;
      m.history.push({ date: log.date, time: log.time, label: H.entryWeightLabel(e), sets: e.sets, total: e.total || 0 });
    });
  });
  Object.values(map).forEach(m => m.history.sort((a, b) =>
    (b.date || '').localeCompare(a.date || '') || (b.time || '').localeCompare(a.time || '')));
  return map;
}

function monthlyTotals(logs) {
  const months = {};
  logs.forEach(l => {
    const k = (l.date || '').slice(0, 7);
    if (!k) return;
    const m = months[k] = months[k] || { total: 0, sessions: 0, days: new Set() };
    m.total += l.total || 0;
    m.sessions += 1;
    m.days.add(l.date);
  });
  return months;
}

/* ── サマリーノート ───────────────────────────────────────────────────── */
function obsSummaryNote(logs, cardioLogs, ctx) {
  const H = window.IRONLOG.helpers;
  const { days, dates } = groupByDate(logs, cardioLogs);
  const exMap  = byExercise(logs);
  const exList = Object.values(exMap).sort((a, b) => b.total - a.total);
  const total  = logs.reduce((s, l) => s + (l.total || 0), 0);
  const months = monthlyTotals(logs);
  const L = [];

  L.push('---');
  L.push('tags: [筋トレ, IRONLOG]');
  L.push(`書き出し日: ${yamlStr(ctx.today)}`);
  L.push(`累計総重量kg: ${total}`);
  L.push(`記録日数: ${new Set(logs.map(l => l.date)).size}`);
  L.push(`セッション数: ${logs.length}`);
  L.push(`種目数: ${exList.length}`);
  L.push('---');
  L.push('');
  L.push('# 筋トレ');
  L.push('');
  L.push(`書き出し日時: ${ctx.stamp}`);
  L.push('');

  const trainedDays = new Set(logs.map(l => l.date)).size;
  L.push('## 概要');
  L.push('');
  L.push('| 項目 | 内容 |');
  L.push('| --- | --- |');
  L.push(`| 累計扱った総重量 | ${kg(total)} |`);
  L.push(`| 記録日数 | ${trainedDays} 日 |`);
  L.push(`| セッション数 | ${logs.length} 回 |`);
  L.push(`| 1日あたり平均 | ${trainedDays ? kg(Math.round(total / trainedDays)) : '—'} |`);
  if (dates.length) {
    L.push(`| 初回記録 | ${cell(H.jpDate(dates[dates.length - 1]))} |`);
    L.push(`| 最終記録 | ${cell(H.jpDate(dates[0]))} |`);
  }
  if (cardioLogs.length) L.push(`| 有酸素の記録 | ${cardioLogs.length} 件 |`);
  L.push('');

  /* 種目別 */
  L.push('## 種目別');
  L.push('');
  if (!exList.length) {
    L.push('記録はまだありません。');
  } else {
    L.push('| 種目 | 総重量 | 割合 | セット | 回数 | 最高重量 | 最終実施 |');
    L.push('| --- | ---: | ---: | ---: | ---: | ---: | --- |');
    exList.forEach(m => {
      L.push(`| [[${obsFileName(m.name)}]] | ${kg(m.total)} | ${pct(m.total, total)} | ${m.sets} | ${m.sessions} | ${m.maxWeight} kg | ${cell(H.jpDate(m.last))} |`);
    });
    L.push(`| **合計** | **${kg(total)}** |  |  |  |  |  |`);
  }
  L.push('');

  /* 月別 */
  const mk = Object.keys(months).sort().reverse();
  if (mk.length) {
    L.push('## 月別');
    L.push('');
    L.push('| 月 | 総重量 | 記録日数 | セッション |');
    L.push('| --- | ---: | ---: | ---: |');
    mk.forEach(k => {
      const m = months[k];
      L.push(`| ${k} | ${kg(m.total)} | ${m.days.size} 日 | ${m.sessions} |`);
    });
    L.push('');
  }

  /* 最近の記録 */
  L.push('## 最近の記録');
  L.push('');
  if (!dates.length) {
    L.push('記録はまだありません。');
  } else {
    L.push('| 日付 | 内容 | 総重量 |');
    L.push('| --- | --- | ---: |');
    dates.slice(0, 30).forEach(d => {
      const day = days[d];
      const names = [...new Set(day.workouts.flatMap(w => (w.entries || []).map(e => e.name)))];
      const parts = [];
      if (day.workouts.length > 1) parts.push(`${day.workouts.length}回`);
      if (names.length) parts.push(names.join('・'));
      if (day.cardio.length) parts.push(`有酸素${day.cardio.length}件`);
      L.push(`| [[${d}]] (${H.isoWeekday(d)}) | ${cell(parts.join(' / ') || '—')} | ${day.total ? kg(day.total) : '—'} |`);
    });
  }
  L.push('');
  return L.join('\n');
}

/* ── 日別ノート ───────────────────────────────────────────────────────── */
function obsDailyNote(day, ctx, opts) {
  const H = window.IRONLOG.helpers;
  const heading = (opts && opts.headingLevel) || 1;
  const h = n => '#'.repeat(heading + n - 1) + ' ';
  const L = [];

  if (!opts || !opts.inline) {
    L.push('---');
    L.push(`日付: ${day.date}`);
    L.push(`曜日: ${yamlStr(H.isoWeekday(day.date))}`);
    L.push(`総重量kg: ${day.total}`);
    L.push(`セッション数: ${day.workouts.length}`);
    if (day.cardio.length) L.push(`有酸素件数: ${day.cardio.length}`);
    L.push('tags: [筋トレ, 記録]');
    L.push('---');
    L.push('');
  }

  L.push(`${h(1)}${day.date} (${H.isoWeekday(day.date)})`);
  L.push('');
  if (!opts || !opts.inline) {
    L.push(`[[${OBS_FOLDER}]] に戻る`);
    L.push('');
  }
  if (day.total) {
    L.push(`> この日の総重量 **${kg(day.total)}**${day.workouts.length > 1 ? `（${day.workouts.length}セッション）` : ''}`);
    L.push('');
  }

  day.workouts.forEach((log, i) => {
    const title = day.workouts.length > 1
      ? `${i + 1}回目${log.time ? ' — ' + log.time : ''}`
      : (log.time ? log.time : 'トレーニング');
    L.push(`${h(2)}${title}`);
    L.push('');
    L.push('| 種目 | 重量 | セット | 小計 |');
    L.push('| --- | ---: | ---: | ---: |');
    (log.entries || []).forEach(e => {
      L.push(`| [[${obsFileName(e.name)}]] | ${cell(H.entryWeightLabel(e))} | ${e.sets} | ${kg(e.total)} |`);
    });
    L.push(`| **計** |  |  | **${kg(log.total)}** |`);
    L.push('');

    /* セットごとの時刻が残っていれば内訳も出す */
    const detailed = (log.entries || []).filter(e => e.setList && e.setList.length);
    if (detailed.length) {
      L.push('<details><summary>セットの内訳</summary>');
      L.push('');
      detailed.forEach(e => {
        const items = e.setList.map((s, n) => `${n + 1}) ${s.time || '--:--'} ${s.weight}kg`).join(' / ');
        L.push(`- **${e.name}** — ${items}`);
      });
      L.push('');
      L.push('</details>');
      L.push('');
    }
  });

  if (day.cardio.length) {
    L.push(`${h(2)}有酸素`);
    L.push('');
    L.push('| 時刻 | 種目 | 内容 | メモ |');
    L.push('| --- | --- | --- | --- |');
    day.cardio.forEach(c => {
      const t = c.type === 'run' ? 'ランニング' : c.type === 'walk' ? 'ウォーキング' : 'バイク';
      L.push(`| ${c.time || '—'} | ${c.mode === 'sprint' ? 'ダッシュ' : t} | ${cell(H.cardioDetail(c))} | ${cell(c.notes || '')} |`);
    });
    L.push('');
  }
  return L.join('\n');
}

/* ── 種目ノート ───────────────────────────────────────────────────────── */
function obsExerciseNote(m, ctx) {
  const H = window.IRONLOG.helpers;
  const L = [];

  /* 月別 */
  const months = {};
  m.history.forEach(x => {
    const k = (x.date || '').slice(0, 7);
    if (!k) return;
    const mm = months[k] = months[k] || { total: 0, sets: 0, days: new Set() };
    mm.total += x.total; mm.sets += x.sets; mm.days.add(x.date);
  });

  L.push('---');
  L.push(`種目: ${yamlStr(m.name)}`);
  L.push(`総重量kg: ${m.total}`);
  L.push(`総セット: ${m.sets}`);
  L.push(`最高重量kg: ${m.maxWeight}`);
  L.push(`初回: ${yamlStr(m.first)}`);
  L.push(`最終: ${yamlStr(m.last)}`);
  L.push(`書き出し日: ${yamlStr(ctx.today)}`);
  L.push('tags: [筋トレ, 種目]');
  L.push('---');
  L.push('');
  L.push(`# ${m.name}`);
  L.push('');
  L.push(`[[${OBS_FOLDER}]] に戻る`);
  L.push('');

  L.push('## 概要');
  L.push('');
  L.push('| 項目 | 内容 |');
  L.push('| --- | --- |');
  L.push(`| 総重量 | ${kg(m.total)} |`);
  L.push(`| 総セット数 | ${m.sets} |`);
  L.push(`| 実施回数 | ${m.sessions} 回 |`);
  L.push(`| 最高重量 | ${m.maxWeight} kg |`);
  L.push(`| 1回あたり平均 | ${m.sessions ? kg(Math.round(m.total / m.sessions)) : '—'} |`);
  L.push(`| 初回 | ${cell(H.jpDate(m.first))} |`);
  L.push(`| 最終 | ${cell(H.jpDate(m.last))} |`);
  L.push('');

  const mk = Object.keys(months).sort().reverse();
  if (mk.length) {
    L.push('## 月別');
    L.push('');
    L.push('| 月 | 総重量 | セット | 実施日数 |');
    L.push('| --- | ---: | ---: | ---: |');
    mk.forEach(k => L.push(`| ${k} | ${kg(months[k].total)} | ${months[k].sets} | ${months[k].days.size} 日 |`));
    L.push('');
  }

  L.push('## 履歴');
  L.push('');
  L.push('| 日付 | 時刻 | 重量 | セット | 小計 |');
  L.push('| --- | --- | ---: | ---: | ---: |');
  m.history.forEach(x => {
    L.push(`| [[${x.date}]] | ${x.time || '—'} | ${cell(x.label)} | ${x.sets} | ${kg(x.total)} |`);
  });
  L.push('');
  return L.join('\n');
}

/* ── 1ファイル版 ──────────────────────────────────────────────────────── */
function obsSingleNote(logs, cardioLogs, ctx) {
  const { days, dates } = groupByDate(logs, cardioLogs);
  const L = [obsSummaryNote(logs, cardioLogs, ctx).replace(/\[\[([^\]]+)\]\]/g, '$1')];
  L.push('');
  L.push('---');
  L.push('');
  L.push('# 日別の記録');
  L.push('');
  dates.forEach(d => {
    L.push(obsDailyNote(days[d], ctx, { inline: true, headingLevel: 2 }));
    L.push('');
  });
  return L.join('\n');
}

/* ── 書き出すノート一式を組み立てる ───────────────────────────────────── */
function buildIronLogNotes(mode) {
  const logs   = window.IRONLOG.getLogs();
  const cardio = window.IRONLOG.getCardioLogs();
  const H      = window.IRONLOG.helpers;
  const ctx    = { today: H.todayISO(), stamp: new Date().toLocaleString('ja-JP') };

  const { days, dates } = groupByDate(logs, cardio);

  if (mode === 'single') {
    return [{ path: `${OBS_FOLDER}記録.md`, text: obsSingleNote(logs, cardio, ctx) }];
  }

  const notes = [];
  if (mode !== 'daily') {
    notes.push({ path: `${OBS_FOLDER}.md`, text: obsSummaryNote(logs, cardio, ctx) });
  }
  dates.forEach(d => {
    notes.push({ path: `${OBS_DAILY}/${d}.md`, text: obsDailyNote(days[d], ctx) });
  });
  if (mode !== 'daily') {
    const exMap = byExercise(logs);
    Object.values(exMap)
      .sort((a, b) => b.total - a.total)
      .forEach(m => notes.push({ path: `${OBS_EX}/${obsFileName(m.name)}.md`, text: obsExerciseNote(m, ctx) }));
  }
  return notes;
}

/* ── ZIP（無圧縮 store 方式・外部ライブラリ不要）────────────────────── */
let _crcTbl = null;
function _crc32(bytes) {
  if (!_crcTbl) {
    _crcTbl = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      _crcTbl[i] = c >>> 0;
    }
  }
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) crc = _crcTbl[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function _dosDateTime(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time: time & 0xFFFF, date: date & 0xFFFF };
}

function buildZip(files) {
  const enc = new TextEncoder();
  const { time, date } = _dosDateTime(new Date());
  const parts = [], central = [];
  let offset = 0;

  files.forEach(f => {
    const nameBytes = enc.encode(f.name);
    const crc  = _crc32(f.data);
    const size = f.data.length;

    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true);   // UTF-8 のファイル名
    lv.setUint16(8, 0, true);        // 無圧縮
    lv.setUint16(10, time, true);
    lv.setUint16(12, date, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, size, true);
    lv.setUint32(22, size, true);
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    parts.push(local, f.data);

    const cd = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, time, true);
    cv.setUint16(14, date, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, size, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    cd.set(nameBytes, 46);
    central.push(cd);

    offset += local.length + size;
  });

  const cdSize = central.reduce((s, c) => s + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);

  return new Blob([...parts, ...central, eocd], { type: 'application/zip' });
}

/* iOS は共有シート、それ以外はダウンロード */
async function shareOrDownload(blob, fileName) {
  const type = blob.type || 'application/octet-stream';
  if (navigator.share && navigator.canShare) {
    try {
      const file = new File([blob], fileName, { type });
      if (navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: 'IRON LOG' });
        return 'shared';
      }
    } catch (e) {
      if (e && e.name === 'AbortError') return 'cancelled';
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
  return 'downloaded';
}

/* ── 画面から呼ぶ入口 ─────────────────────────────────────────────────── */
async function exportObsidian(mode) {
  const H = window.IRONLOG.helpers;
  if (!window.IRONLOG.getLogs().length && !window.IRONLOG.getCardioLogs().length) {
    H.showToast('⚠️ 書き出せる記録がありません');
    return;
  }

  const notes = buildIronLogNotes(mode);
  const stamp = H.todayISO();

  try {
    let result;
    if (mode === 'single') {
      const blob = new Blob([notes[0].text], { type: 'text/markdown;charset=utf-8' });
      result = await shareOrDownload(blob, `${OBS_FOLDER}記録_${stamp}.md`);
    } else {
      const enc = new TextEncoder();
      const zip = buildZip(notes.map(n => ({ name: n.path, data: enc.encode(n.text) })));
      result = await shareOrDownload(zip, `ironlog_obsidian_${mode}_${stamp}.zip`);
    }
    if (result === 'cancelled') return;
    H.showToast(`🗒 ${notes.length}件のノートを書き出しました`);
  } catch (e) {
    H.showToast('⚠️ 書き出しに失敗しました：' + (e.message || e));
  }
}
