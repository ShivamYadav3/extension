/* Meet Attendance Tracker v1.2 - popup */
const $ = (s) => document.querySelector(s);
const VERSION = '1.2';
const STALE_MS = 30000;
const BLIP_MS = 5000; // sessions shorter than this are reconnect blips, not a second device
let state = null, meetingId = null, selected = null;

// ---- interval math --------------------------------------------------------
const isOpen = (p) => { const l = p.sessions[p.sessions.length - 1]; return !!l && l.e == null; };

function unionMs(list, ref) {
  const iv = (list || []).map((i) => [i.s, i.e ?? ref]).filter(([s, e]) => e > s).sort((a, b) => a[0] - b[0]);
  let total = 0, cs = null, ce = null;
  for (const [s, e] of iv) {
    if (cs === null) { cs = s; ce = e; }
    else if (s <= ce) ce = Math.max(ce, e);
    else { total += ce - cs; cs = s; ce = e; }
  }
  return cs === null ? total : total + (ce - cs);
}

function peakConcurrent(list, ref) {
  const ev = [];
  for (const i of list) { const e = i.e ?? ref; if (e > i.s) ev.push([i.s, 1], [e, -1]); }
  ev.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let cur = 0, peak = 0;
  for (const [, d] of ev) { cur += d; peak = Math.max(peak, cur); }
  return peak;
}

function mergeVisits(list, ref) {
  const iv = list.map((i) => ({ s: i.s, e: i.e ?? ref, open: i.e == null })).filter((i) => i.e > i.s).sort((a, b) => a.s - b.s);
  const out = [];
  for (const c of iv) {
    const last = out[out.length - 1];
    if (!last || c.s > last.e) out.push({ ...c });
    else { last.e = Math.max(last.e, c.e); last.open = last.open || c.open; }
  }
  return out.map((v, i) => ({
    n: i + 1, s: v.s, e: v.e, open: v.open,
    awayAfter: out[i + 1] ? Math.max(0, out[i + 1].s - v.e) : null,
  }));
}

// ---- aggregate by display name -------------------------------------------
const shortId = (pid) => String(pid || '').split('/').pop();

function aggregate(st, ref) {
  const groups = new Map();
  for (const p of Object.values(st.participants || {})) {
    const name = p.name || `Participant ${shortId(p.id)}`;
    if (!groups.has(name)) groups.set(name, { name, devices: [] });
    groups.get(name).devices.push(p);
  }
  const rows = [...groups.values()].map((g) => {
    g.devices.sort((a, b) => ((a.sessions[0] || {}).s || 0) - ((b.sessions[0] || {}).s || 0));
    const sessions = g.devices.flatMap((d) => d.sessions || []);
    const cam = g.devices.flatMap((d) => d.cam || []);
    const visits = mergeVisits(sessions, ref);
    const active = g.devices.filter(isOpen).length;
    return {
      name: g.name, devices: g.devices, visits, active,
      totalMs: unionMs(sessions, ref), camMs: unionMs(cam, ref),
      awayMs: visits.reduce((a, v) => a + (v.awayAfter || 0), 0),
      peak: peakConcurrent(sessions.filter((x) => (x.e ?? ref) - x.s >= BLIP_MS), ref),
      firstJoin: sessions.length ? Math.min(...sessions.map((s) => s.s)) : 0,
      lastLeave: active || !sessions.length ? null : Math.max(...sessions.map((s) => s.e ?? ref)),
      pre: g.devices.some((d) => d.joinedBeforeTracking),
    };
  });
  return rows.sort((a, b) => a.firstJoin - b.firstJoin);
}

// ---- formatting -----------------------------------------------------------
const pad = (n) => String(n).padStart(2, '0');
function fmtDur(ms) {
  const s = Math.floor(Math.max(0, ms || 0) / 1000);
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}
function fmtDT(ms) {
  if (!ms) return '—';
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
const fmtT = (ms) => fmtDT(ms).slice(11);

function refTime() {
  const stale = !!state && Date.now() - (state.lastSeen || 0) > STALE_MS;
  return { ref: stale ? state.lastSeen : Date.now(), stale };
}

// ---- DOM helpers ----------------------------------------------------------
function td(tr, text, cls) {
  const c = document.createElement('td');
  c.textContent = text == null ? '' : String(text);
  if (cls) c.className = cls;
  tr.appendChild(c);
  return c;
}
function meta(parent, label, value) {
  const d = document.createElement('div');
  const b = document.createElement('strong');
  b.textContent = label + ': ';
  d.append(b, document.createTextNode(value));
  parent.appendChild(d);
}

function renderDetail(row, ref) {
  const box = $('#detail');
  if (!row) { box.hidden = true; return; }
  box.hidden = false;
  $('#dtitle').textContent = row.name;
  const m = $('#meta'); m.textContent = '';
  meta(m, 'First seen', fmtDT(row.firstJoin));
  meta(m, 'Last left', row.lastLeave ? fmtDT(row.lastLeave) : 'still in meeting');
  meta(m, 'Total in meeting', fmtDur(row.totalMs));
  meta(m, 'Total camera on', fmtDur(row.camMs));
  meta(m, 'Time away (between visits)', fmtDur(row.awayMs));
  meta(m, 'Devices now / peak', `${row.active} / ${row.peak}`);
  if (row.pre) meta(m, 'Note', 'Already in the meeting when tracking started; first seen may not be the true join time');

  const v = $('#visits'); v.textContent = '';
  for (const x of row.visits) {
    const tr = document.createElement('tr');
    td(tr, x.n); td(tr, fmtDT(x.s)); td(tr, x.open ? 'still in meeting' : fmtDT(x.e));
    td(tr, fmtDur(x.e - x.s)); td(tr, x.awayAfter == null ? '—' : fmtDur(x.awayAfter));
    v.appendChild(tr);
  }
  const dv = $('#devs'); dv.textContent = '';
  for (const d of row.devices) {
    const tr = document.createElement('tr');
    const first = d.sessions.length ? Math.min(...d.sessions.map((s) => s.s)) : 0;
    const open = isOpen(d);
    const last = open || !d.sessions.length ? null : Math.max(...d.sessions.map((s) => s.e || 0));
    const brief = !open && last !== null && last - first < BLIP_MS;
    td(tr, `Device ${row.devices.indexOf(d) + 1} \u00b7 ${d.deviceId || shortId(d.id)}`);
    td(tr, open ? 'in meeting' : (brief ? 'left (brief reconnect)' : 'left'));
    td(tr, fmtDT(first)); td(tr, open ? 'still in meeting' : fmtDT(last)); td(tr, fmtDur(unionMs(d.cam, ref)));
    dv.appendChild(tr);
  }
}

function render() {
  const tbody = $('#rows'); tbody.textContent = '';
  const status = $('#status');
  const has = state && Object.keys(state.participants || {}).length;
  $('#empty').hidden = !!has;
  $('#clear').disabled = !state;
  $('#export').disabled = !has;
  if (!has) {
    status.textContent = state ? `Meeting ${state.meetingId}` : 'Idle';
    status.classList.remove('warn');
    renderDetail(null);
    return;
  }
  const { ref, stale } = refTime();
  const rows = aggregate(state, ref);
  for (const r of rows) {
    const tr = document.createElement('tr');
    if (!r.active) tr.classList.add('gone');
    if (r.name === selected) tr.classList.add('sel');
    const c = document.createElement('td');
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'name'; b.textContent = r.name;
    b.addEventListener('click', () => { selected = selected === r.name ? null : r.name; render(); });
    c.appendChild(b); tr.appendChild(c);
    td(tr, fmtDur(r.totalMs)); td(tr, fmtDur(r.camMs));
    td(tr, r.peak > r.active && r.peak > 1 ? `${r.active} (peak ${r.peak})` : r.active);
    td(tr, r.devices.map((d) => (d.deviceId || shortId(d.id)) + (isOpen(d) ? '' : ' (left)')).join(', '), 'l');
    tbody.appendChild(tr);
  }
  const sel = rows.find((r) => r.name === selected) || null;
  if (selected && !sel) selected = null;
  renderDetail(sel, ref);

  const inNow = rows.filter((r) => r.active).length;
  const old = state.trackerVersion !== VERSION;
  status.textContent = stale ? `Paused: no Meet tab reporting (${state.meetingId})`
    : old ? `${state.meetingId} · OLD data: click "Clear this meeting"`
    : `${state.meetingId} · ${inNow} in meeting`;
  status.classList.toggle('warn', stale || old);
}

// ---- CSV ------------------------------------------------------------------
function csvCell(v) {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function exportCsv() {
  if (!state) return;
  const { ref } = refTime();
  const head = ['Name', 'First Seen', 'Last Left', 'Total Time', 'Camera On', 'Time Away', 'Total Sec', 'Camera Sec', 'Away Sec',
    'Active Devices Now', 'Peak Devices', 'Session IDs', 'Device Sessions', 'Join/Leave Log', 'Note'];
  const lines = [head.map(csvCell).join(',')];
  for (const r of aggregate(state, ref)) {
    const log = r.visits.map((v) => `${fmtT(v.s)} -> ${v.open ? 'still in meeting' : fmtT(v.e)} (${fmtDur(v.e - v.s)}${v.awayAfter ? '; away ' + fmtDur(v.awayAfter) : ''})`).join(' | ');
    const devSess = r.devices.map((d, i) => {
      const f = Math.min(...d.sessions.map((x) => x.s));
      const o = isOpen(d);
      const l = o ? null : Math.max(...d.sessions.map((x) => x.e || 0));
      return `Device ${i + 1} (${d.deviceId || shortId(d.id)}): ${fmtT(f)} -> ${o ? 'still in meeting' : fmtT(l)}, camera ${fmtDur(unionMs(d.cam, ref))}`;
    }).join(' | ');
    lines.push([r.name, fmtDT(r.firstJoin), r.lastLeave ? fmtDT(r.lastLeave) : 'still in meeting', fmtDur(r.totalMs), fmtDur(r.camMs), fmtDur(r.awayMs),
      Math.floor(r.totalMs / 1000), Math.floor(r.camMs / 1000), Math.floor(r.awayMs / 1000), r.active, r.peak,
      r.devices.map((d) => d.deviceId || shortId(d.id)).join(' | '), devSess, log,
      r.pre ? 'Already in meeting when tracking started' : ''].map(csvCell).join(','));
  }
  const url = URL.createObjectURL(new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `meet-attendance-${state.meetingId}-${fmtDT(Date.now()).replace(/[: ]/g, '-')}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---- data flow ------------------------------------------------------------
async function activeTab() {
  try { return (await chrome.tabs.query({ active: true, currentWindow: true }))[0] || null; } catch (_) { return null; }
}
async function refresh() {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'GET_STATE', meetingId });
    state = res && res.state ? res.state : null;
  } catch (_) { state = null; }
  render();
}

$('#export').addEventListener('click', exportCsv);
$('#clear').addEventListener('click', async () => {
  if (!state || !confirm('Clear all tracked data for this meeting?')) return;
  try { await chrome.runtime.sendMessage({ type: 'CLEAR', meetingId: state.meetingId }); } catch (_) {}
  state = null; selected = null; render(); setTimeout(refresh, 700);
});
$('#diagbtn').addEventListener('click', async () => {
  const box = $('#diag'); box.hidden = false;
  const tab = await activeTab();
  try {
    const txt = await chrome.tabs.sendMessage(tab.id, { type: 'DIAG' });
    box.value = txt || 'No response from the Meet tab. Refresh it and try again.';
    try { await navigator.clipboard.writeText(box.value); } catch (_) { box.select(); }
  } catch (_) {
    box.value = 'The v1.2 content script is not running in this tab. Close the Meet tab, rejoin, and try again.';
  }
});

(async () => {
  const tab = await activeTab();
  const m = tab && tab.url && tab.url.match(/^https:\/\/meet\.google\.com\/([a-z]{3}-[a-z]{4}-[a-z]{3})/i);
  meetingId = m ? m[1] : null;
  await refresh();
  setInterval(refresh, 1000);
})();

// ---- which build is Chrome really running? --------------------------------
(function showBuild() {
  const m = chrome.runtime.getManifest();
  const cs = ((m.content_scripts || [])[0] || {}).js || [];
  const bg = (m.background || {}).service_worker || '?';
  const ok = m.version === '1.2.1' && cs.includes('tracker-v12.js') && bg === 'service-v12.js';
  const el = $('#build');
  el.textContent = `Loaded build: manifest ${m.version} | page script: ${cs.join(', ') || '?'} | worker: ${bg}` +
    (ok ? '  OK' : '  WRONG: manifest.json is not the new one. Replace manifest.json, then reload the extension.');
  if (!ok) { el.style.color = '#dc2626'; el.style.opacity = '1'; el.style.fontWeight = '600'; }
})();