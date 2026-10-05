/* Meet Attendance Tracker - popup dashboard */
const $ = (sel) => document.querySelector(sel);
const STALE_MS = 30000;

let state = null;
let meetingId = null;
let selectedName = null;

const isOpen = (p) => p.sessions.length && p.sessions[p.sessions.length - 1].e === null;

function unionMs(intervals, ref) {
  const iv = intervals
    .map((i) => [i.s, i.e ?? ref])
    .filter(([s, e]) => e > s)
    .sort((a, b) => a[0] - b[0]);
  let total = 0, cs = null, ce = null;
  for (const [s, e] of iv) {
    if (cs === null) { cs = s; ce = e; }
    else if (s <= ce) { ce = Math.max(ce, e); }
    else { total += ce - cs; cs = s; ce = e; }
  }
  if (cs !== null) total += ce - cs;
  return total;
}

function peakConcurrent(intervals, ref) {
  const events = [];
  for (const i of intervals) {
    const e = i.e ?? ref;
    if (e > i.s) { events.push([i.s, 1], [e, -1]); }
  }
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let cur = 0, peak = 0;
  for (const [, d] of events) { cur += d; peak = Math.max(peak, cur); }
  return peak;
}

/** Contiguous in-meeting windows after merging overlapping device sessions. */
function mergeVisits(sessions, ref) {
  const iv = sessions
    .map((i) => ({ s: i.s, e: i.e ?? ref, open: i.e == null }))
    .filter((i) => i.e > i.s)
    .sort((a, b) => a.s - b.s);
  const out = [];
  for (const cur of iv) {
    const last = out[out.length - 1];
    if (!last || cur.s > last.e) {
      out.push({ s: cur.s, e: cur.e, open: cur.open });
    } else {
      last.e = Math.max(last.e, cur.e);
      last.open = last.open || cur.open;
    }
  }
  return out;
}

function visitStats(visits, ref) {
  let awayMs = 0;
  const rows = visits.map((v, i) => {
    const next = visits[i + 1];
    const away = next ? Math.max(0, next.s - v.e) : (v.open ? 0 : Math.max(0, ref - v.e));
    awayMs += away;
    return {
      n: i + 1,
      joined: v.s,
      left: v.open ? null : v.e,
      duration: v.e - v.s,
      awayAfter: next || !v.open ? away : null,
      open: v.open,
    };
  });
  return { rows, awayMs };
}

function aggregate(st, ref) {
  const groups = new Map();
  for (const p of Object.values(st.participants || {})) {
    const g = groups.get(p.name) || { name: p.name, devices: [] };
    g.devices.push(p);
    groups.set(p.name, g);
  }
  const rows = [...groups.values()].map((g) => {
    const sessions = g.devices.flatMap((d) => d.sessions);
    const cam = g.devices.flatMap((d) => d.cam);
    const active = g.devices.filter(isOpen).length;
    const firstJoin = Math.min(...sessions.map((s) => s.s));
    const stillIn = active > 0;
    const lastLeave = stillIn ? null : Math.max(...sessions.map((s) => s.e ?? ref));
    const visits = mergeVisits(sessions, ref);
    const stats = visitStats(visits, ref);
    return {
      name: g.name,
      totalMs: unionMs(sessions, ref),
      camMs: unionMs(cam, ref),
      awayMs: stats.awayMs,
      visitRows: stats.rows,
      active,
      peak: peakConcurrent(sessions, ref),
      firstJoin,
      lastLeave,
      preExisting: g.devices.some((d) => d.joinedBeforeTracking),
      devices: g.devices,
    };
  });
  rows.sort((a, b) => a.firstJoin - b.firstJoin);
  return rows;
}

const pad = (n) => String(n).padStart(2, '0');

function fmtDuration(ms) {
  const s = Math.floor(Math.max(0, ms) / 1000);
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

function fmtDateTime(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
         `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

const fmtTime = (ms) => fmtDateTime(ms).slice(11);
const shortId = (pid) => String(pid).split('/').pop();

function refTime() {
  const stale = state && Date.now() - (state.lastSeen || 0) > STALE_MS;
  return { ref: stale ? state.lastSeen : Date.now(), stale };
}

function cell(tr, text) {
  const td = document.createElement('td');
  td.textContent = text;
  tr.appendChild(td);
  return td;
}

function metaLine(parent, label, value) {
  const div = document.createElement('div');
  const b = document.createElement('strong');
  b.textContent = label + ': ';
  div.appendChild(b);
  div.appendChild(document.createTextNode(value));
  parent.appendChild(div);
}

function renderDetail(row, ref) {
  const box = $('#detail');
  if (!row) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  $('#detail-title').textContent = row.name;

  const meta = $('#detail-meta');
  meta.textContent = '';
  metaLine(meta, 'First seen', fmtDateTime(row.firstJoin));
  metaLine(meta, 'Last left', row.lastLeave ? fmtDateTime(row.lastLeave) : 'still in meeting');
  metaLine(meta, 'Total in meeting', fmtDuration(row.totalMs));
  metaLine(meta, 'Total camera on', fmtDuration(row.camMs));
  metaLine(meta, 'Time away (after leaving)', fmtDuration(row.awayMs));
  metaLine(meta, 'Devices now / peak', `${row.active} / ${row.peak}`);
  if (row.preExisting) {
    metaLine(meta, 'Note', 'Already in the meeting when tracking started; first seen may not be the true join time');
  }

  const visits = $('#visits');
  visits.textContent = '';
  for (const v of row.visitRows) {
    const tr = document.createElement('tr');
    cell(tr, String(v.n));
    cell(tr, fmtDateTime(v.joined));
    cell(tr, v.left ? fmtDateTime(v.left) : 'still in meeting');
    cell(tr, fmtDuration(v.duration));
    cell(tr, v.awayAfter == null ? '—' : (v.open ? '—' : fmtDuration(v.awayAfter)));
    visits.appendChild(tr);
  }

  const devices = $('#detail-devices');
  devices.textContent = '';
  for (const d of row.devices) {
    const tr = document.createElement('tr');
    const open = isOpen(d);
    const first = d.sessions.length ? Math.min(...d.sessions.map((s) => s.s)) : null;
    const last = open ? null : (d.sessions.length ? Math.max(...d.sessions.map((s) => s.e || 0)) : null);
    cell(tr, shortId(d.id));
    cell(tr, open ? 'in meeting' : 'left');
    cell(tr, first ? fmtDateTime(first) : '—');
    cell(tr, last ? fmtDateTime(last) : (open ? 'still in meeting' : '—'));
    devices.appendChild(tr);
  }
}

function render() {
  const tbody = $('#rows');
  tbody.textContent = '';
  const empty = $('#empty');
  const status = $('#status');

  if (!state || !Object.keys(state.participants || {}).length) {
    empty.hidden = false;
    status.textContent = state ? `Meeting ${state.meetingId}` : 'Idle';
    status.classList.remove('warn');
    $('#export').disabled = true;
    $('#clear').disabled = !state;
    selectedName = null;
    renderDetail(null);
    return;
  }

  empty.hidden = true;
  const { ref, stale } = refTime();
  const rows = aggregate(state, ref);

  for (const r of rows) {
    const tr = document.createElement('tr');
    if (!r.active) tr.classList.add('left');
    if (r.name === selectedName) tr.classList.add('selected');

    const tdName = document.createElement('td');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'name-btn';
    btn.textContent = r.name;
    btn.addEventListener('click', () => {
      selectedName = selectedName === r.name ? null : r.name;
      render();
    });
    tdName.appendChild(btn);
    tr.appendChild(tdName);

    cell(tr, fmtDuration(r.totalMs));
    cell(tr, fmtDuration(r.camMs));
    cell(tr, r.peak > r.active && r.peak > 1 ? `${r.active} (peak ${r.peak})` : String(r.active));
    tbody.appendChild(tr);
  }

  const selected = rows.find((r) => r.name === selectedName) || null;
  if (selectedName && !selected) selectedName = null;
  renderDetail(selected, ref);

  const inNow = rows.filter((r) => r.active).length;
  status.textContent = stale
    ? `Paused: no Meet tab reporting (${state.meetingId})`
    : `${state.meetingId} · ${inNow} in meeting`;
  status.classList.toggle('warn', stale);
  $('#export').disabled = false;
  $('#clear').disabled = false;
}

function csvCell(v) {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function exportCsv() {
  if (!state) return;
  const { ref } = refTime();
  const rows = aggregate(state, ref);

  const header = [
    'Name', 'First Seen', 'Last Left', 'Total Time (hh:mm:ss)', 'Camera On (hh:mm:ss)',
    'Time Away (hh:mm:ss)', 'Total Seconds', 'Camera Seconds', 'Away Seconds',
    'Active Devices Now', 'Peak Simultaneous Devices', 'Device Session Ids',
    'Join/Leave Log', 'Note',
  ];

  const lines = [header.map(csvCell).join(',')];
  for (const r of rows) {
    const log = r.visitRows
      .map((v) => {
        const left = v.left ? fmtTime(v.left) : 'still in meeting';
        const away = v.awayAfter && !v.open ? `; away ${fmtDuration(v.awayAfter)}` : '';
        return `${fmtTime(v.joined)} -> ${left} (${fmtDuration(v.duration)}${away})`;
      })
      .join(' | ');
    lines.push([
      r.name,
      fmtDateTime(r.firstJoin),
      r.lastLeave ? fmtDateTime(r.lastLeave) : 'still in meeting',
      fmtDuration(r.totalMs),
      fmtDuration(r.camMs),
      fmtDuration(r.awayMs),
      Math.floor(r.totalMs / 1000),
      Math.floor(r.camMs / 1000),
      Math.floor(r.awayMs / 1000),
      r.active,
      r.peak,
      r.devices.map((d) => shortId(d.id)).join(' | '),
      log,
      r.preExisting ? 'Already in meeting when tracking started; first seen is not true join time' : '',
    ].map(csvCell).join(','));
  }

  const blob = new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `meet-attendance-${state.meetingId}-${fmtDateTime(Date.now()).replace(/[: ]/g, '-')}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function activeMeetingId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const m = tab && tab.url && tab.url.match(/^https:\/\/meet\.google\.com\/([a-z]{3}-[a-z]{4}-[a-z]{3})/);
  return m ? m[1] : null;
}

async function refresh() {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'GET_STATE', meetingId });
    state = (res && res.state) || null;
  } catch (_) {
    state = null;
  }
  render();
}

$('#export').addEventListener('click', exportCsv);
$('#clear').addEventListener('click', async () => {
  if (!state || !confirm('Clear all tracked data for this meeting?')) return;
  await chrome.runtime.sendMessage({ type: 'CLEAR', meetingId: state.meetingId });
  state = null;
  selectedName = null;
  render();
  setTimeout(refresh, 500);
});

(async () => {
  meetingId = await activeMeetingId();
  await refresh();
  setInterval(refresh, 1000);
})();
