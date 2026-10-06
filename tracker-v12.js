/* Meet Attendance Tracker - content.js (v1.1)
 * Fixes: icon ligature text ("frame_person", "keep_outline") was being stored as
 * participant names, merging everyone into 1-2 rows.
 */
(() => {
  'use strict';
  if (window.__meetAttendanceTracker) return;
  window.__meetAttendanceTracker = true;
  console.log('[MeetTracker] v1.2 loaded (icon-name fix)');

  const CONFIG = {
    containerSelector: '.Ge9Kpc.z38b6',
    tileSelector: '[data-participant-id]',
    leaveDebounceMs: 2000,
    startupGraceMs: 6000,
    resumeWindowMs: 30000,
    newMeetingAfterMs: 6 * 60 * 60 * 1000,
    tickMs: 1000,
    heartbeatMs: 5000,
    syncDebounceMs: 150,
  };

  const MEETING_RE = /^\/([a-z]{3}-[a-z]{4}-[a-z]{3})\/?$/i;

  let state = null;
  let dirty = false;
  let initializing = false;
  let startAt = Date.now();
  let lastHeartbeat = 0;
  let observer = null;
  let observedTarget = null;
  let syncTimer = null;
  const missingSince = new Map();

  // ---------------------------------------------------------------------------
  // Name cleaning (privacy + icon rejection) - ONE definition of each
  // ---------------------------------------------------------------------------
  const ICON_WORDS = new Set([
    'person', 'frame_person', 'person_off', 'account_circle', 'face', 'keep', 'keep_outline',
    'keep_off', 'mic', 'mic_off', 'mic_none', 'videocam', 'videocam_off', 'more_vert',
    'more_horiz', 'push_pin', 'close', 'check', 'done', 'search', 'settings', 'devices',
    'present_to_all', 'screen_share', 'hand_gesture', 'back_hand', 'call_end', 'chat',
    'arrow_drop_down', 'visibility', 'visibility_off', 'open_in_full', 'fullscreen',
  ]);
  const UI_WORDS = /^(presenting|host|co-host|pin|unpin|mute|unmute|more|options|camera|microphone|muted|unmuted|your presentation|you are presenting)$/i;

  const looksLikeIcon = (s) =>
    ICON_WORDS.has(s.toLowerCase()) || /^[a-z][a-z0-9]*(_[a-z0-9]+)+$/.test(s);

  function cleanName(raw) {
    if (!raw) return null;
    let s = String(raw).replace(/\s+/g, ' ').trim();
    s = s.replace(/\s*\((you|toi|tú|du)\)\s*$/i, '').trim();
    if (!s || s.length > 60) return null;
    if (s.includes('@')) return null;                        // email-like
    if ((s.match(/\d/g) || []).length >= 7) return null;     // phone-like
    if (looksLikeIcon(s)) return null;                       // icon ligature
    if (UI_WORDS.test(s)) return null;
    if (/^you$/i.test(s)) return null;                       // handled separately
    return s;
  }

  const fallbackName = (pid) =>
    `Participant ${String(pid || '').split('/').filter(Boolean).pop()?.slice(-6) || 'unknown'}`;

  const isBadStoredName = (n) => !n || /^Participant /.test(n) || !cleanName(n);

  const extractDeviceId = (pid) => {
    const m = String(pid || '').match(/\/devices\/([^/?#]+)/i);
    return m ? m[1] : String(pid || '').split('/').filter(Boolean).pop() || 'unknown';
  };

  // ---------------------------------------------------------------------------
  // DOM helpers
  // ---------------------------------------------------------------------------
  function isHidden(el) {
    if (!el || el.hidden) return true;
    try {
      if (el.getClientRects().length === 0) return true;
      const cs = getComputedStyle(el);
      return cs.display === 'none' || cs.visibility === 'hidden';
    } catch (_) { return false; }
  }

  // True if text inside `el` is drawn with an icon font (Material / Google Symbols).
  function isIconText(el, stop) {
    for (let n = el; n && n !== stop && n.nodeType === 1; n = n.parentElement) {
      const cls = typeof n.className === 'string' ? n.className : '';
      if (/google-symbols|material-icons|material-symbols|gm-icon|google-material-icons/i.test(cls)) return true;
      if (n === el) {
        try {
          if (/symbol|material|icon/i.test(getComputedStyle(n).fontFamily || '')) return true;
        } catch (_) {}
      }
    }
    return false;
  }

  // Name lookup, strictly INSIDE the tile (never climbs to the grid, so it can't
  // pick up another participant's name). Buttons and icon text are ignored,
  // which removes pin/mute/more-options labels.
  function extractName(tile) {
    // 1) Explicit attribute
    const attrEl = tile.matches('[data-self-name]') ? tile : tile.querySelector('[data-self-name]');
    if (attrEl) {
      const n = cleanName(attrEl.getAttribute('data-self-name'));
      if (n) return n;
    }

    // 2) Visible text nodes
    const walker = document.createTreeWalker(tile, NodeFilter.SHOW_TEXT);
    let best = null;
    let sawYou = false;
    let order = 0;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const el = node.parentElement;
      const raw = node.nodeValue;
      if (!el || !raw || !raw.trim()) continue;
      if (el.closest('button, [role="button"], [role="menu"], [role="menuitem"], [role="tooltip"]')) continue;
      if (isIconText(el, tile) || isHidden(el)) continue;

      if (/^\s*you\s*$/i.test(raw)) { sawYou = true; continue; }
      const name = cleanName(raw);
      if (!name) continue;

      let score = 0;
      if (el.closest('.notranslate')) score += 50;
      const words = name.split(' ').length;
      if (words >= 1 && words <= 5) score += 10;
      score -= order * 0.01; // earlier in DOM wins ties
      order++;
      if (!best || score > best.score) best = { name, score };
    }
    if (best) return best.name;
    return sawYou ? 'You' : null;
  }

  function isCameraOn(tile) {
    for (const v of tile.querySelectorAll('video')) {
      if (isHidden(v) || v.paused || v.ended) continue;
      if (v.readyState < 2 || !v.videoWidth) continue;
      const stream = v.srcObject;
      if (stream && typeof stream.getVideoTracks === 'function') {
        if (!stream.getVideoTracks().some((t) => t.readyState === 'live')) continue;
      }
      return true;
    }
    return false;
  }

  // ---------------------------------------------------------------------------
  // Interval helpers
  // ---------------------------------------------------------------------------
  const lastOf = (l) => l[l.length - 1];
  function openIfNone(list, at) {
    const last = lastOf(list);
    if (last && last.e === null) return false;
    list.push({ s: at, e: null });
    return true;
  }
  function closeOpen(list, at) {
    const last = lastOf(list);
    if (!last || last.e !== null) return false;
    last.e = Math.max(at, last.s);
    return true;
  }
  function closeAllOpen(st, at) {
    for (const p of Object.values(st.participants || {})) {
      closeOpen(p.sessions, at);
      closeOpen(p.cam, at);
    }
  }
  const freshState = (id) => ({ meetingId: id, startedAt: Date.now(), lastSeen: Date.now(), participants: {} });

  // Repairs data saved by older versions (icon names stored as real names)
  function migrateState() {
    if (!state || !state.participants) return;
    for (const p of Object.values(state.participants)) {
      if (!Array.isArray(p.sessions)) p.sessions = [];
      if (!Array.isArray(p.cam)) p.cam = [];
      if (!p.deviceId) p.deviceId = extractDeviceId(p.id);
      if (!cleanName(p.name) && !/^Participant /.test(p.name || '') && p.name !== 'You') {
        p.name = fallbackName(p.id);
      }
    }
  }

  // Screen-share tiles carry zoom / pop-out controls and are not people.
  function isPresentationTile(tile) {
    for (const el of tile.querySelectorAll('i')) {
      const t = (el.textContent || '').trim();
      if (t === 'zoom_in' || t === 'open_in_new') return true;
    }
    return false;
  }

  // ---------------------------------------------------------------------------
  // Reconcile DOM with state
  // ---------------------------------------------------------------------------
  function sync() {
    if (!state) return;
    const now = Date.now();
    const root = document.querySelector(CONFIG.containerSelector) || document;

    const seen = new Map();
    for (const tile of root.querySelectorAll(CONFIG.tileSelector)) {
      const pid = tile.getAttribute('data-participant-id');
      if (!pid || pid.length > 500 || pid.includes('@')) continue;
      if (isHidden(tile)) continue;
      if (isPresentationTile(tile)) continue;
      const entry = seen.get(pid) || { name: null, cam: false };
      entry.name = entry.name || extractName(tile);
      if (entry.name && /\(presentation\)\s*$/i.test(entry.name)) continue;
      entry.cam = entry.cam || isCameraOn(tile);
      seen.set(pid, entry);
    }

    const firstBatch = Object.keys(state.participants).length === 0;

    for (const [pid, info] of seen) {
      missingSince.delete(pid);
      let p = state.participants[pid];
      if (!p) {
        p = state.participants[pid] = {
          id: pid,
          name: info.name || fallbackName(pid),
          deviceId: extractDeviceId(pid),
          deviceHint: null,
          joinedBeforeTracking: firstBatch,
          sessions: [],
          cam: [],
        };
        dirty = true;
      }
      if (info.name && p.name !== info.name) { p.name = info.name; dirty = true; }
      else if (!info.name && isBadStoredName(p.name) && !/^Participant /.test(p.name || '')) {
        p.name = fallbackName(pid); dirty = true;
      }
      if (openIfNone(p.sessions, now)) dirty = true;
      if (info.cam) { if (openIfNone(p.cam, now)) dirty = true; }
      else if (closeOpen(p.cam, now)) dirty = true;
    }

    if (now - startAt >= CONFIG.startupGraceMs) {
      for (const p of Object.values(state.participants)) {
        if (seen.has(p.id)) continue;
        const open = lastOf(p.sessions);
        if (!open || open.e !== null) continue;
        const since = missingSince.get(p.id) ?? now;
        missingSince.set(p.id, since);
        if (closeOpen(p.cam, since)) dirty = true;
        if (now - since >= CONFIG.leaveDebounceMs) {
          closeOpen(p.sessions, since);
          missingSince.delete(p.id);
          dirty = true;
        }
      }
    }

    if (now - lastHeartbeat >= CONFIG.heartbeatMs) {
      state.lastSeen = now; lastHeartbeat = now; dirty = true;
    }
  }

  const scheduleSync = () => {
    if (syncTimer) return;
    syncTimer = setTimeout(() => { syncTimer = null; sync(); }, CONFIG.syncDebounceMs);
  };

  // ---------------------------------------------------------------------------
  // Observer
  // ---------------------------------------------------------------------------
  const MEDIA_EVENTS = ['play', 'pause', 'ended', 'emptied', 'loadeddata', 'loadedmetadata'];

  function attachObserver() {
    const target = document.querySelector(CONFIG.containerSelector) || document.body;
    if (!target || target === observedTarget) return;
    if (observer) observer.disconnect();
    if (observedTarget) MEDIA_EVENTS.forEach((e) => observedTarget.removeEventListener(e, scheduleSync, true));
    observer = new MutationObserver(scheduleSync);
    observer.observe(target, {
      childList: true,
      subtree: true,
      characterData: true, // names rendered after the tile appears
      attributes: true,
      attributeFilter: ['style', 'class', 'hidden', 'data-self-name'],
    });
    MEDIA_EVENTS.forEach((e) => target.addEventListener(e, scheduleSync, true));
    observedTarget = target;
  }

  // ---------------------------------------------------------------------------
  // Messaging / lifecycle
  // ---------------------------------------------------------------------------
  function send(msg) {
    try {
      const r = chrome.runtime.sendMessage(msg);
      return r && typeof r.catch === 'function' ? r.catch(() => null) : Promise.resolve(r);
    } catch (_) { return Promise.resolve(null); }
  }

  function flush(force = false) {
    if (!state || !(dirty || force)) return;
    dirty = false;
    state.trackerVersion = '1.2';
    send({ type: 'SYNC', meetingId: state.meetingId, state });
  }

  async function loadMeeting(id) {
    initializing = true;
    try {
      if (state) { closeAllOpen(state, Date.now()); flush(true); }
      const res = await send({ type: 'GET_STATE', meetingId: id });
      const now = Date.now();
      let st = res && res.state && res.state.meetingId === id ? res.state : null;
      if (st) {
        const gap = now - (st.lastSeen || 0);
        if (gap > CONFIG.newMeetingAfterMs) st = null;
        else if (gap > CONFIG.resumeWindowMs) closeAllOpen(st, st.lastSeen || now);
      }
      state = st || freshState(id);
      migrateState();
      startAt = Date.now();
      missingSince.clear();
      dirty = true;
    } finally { initializing = false; }
  }

  // Diagnostics: tile structure with letters masked (names never leave the page).
  const shape = (t) => {
    const x = String(t).trim();
    return looksLikeIcon(x) ? x : x.replace(/\p{L}/gu, (c) => (c !== c.toLowerCase() ? 'A' : 'a')).replace(/\d/g, '9');
  };
  function buildDiag() {
    const root = document.querySelector(CONFIG.containerSelector);
    const tiles = [...(root || document).querySelectorAll(CONFIG.tileSelector)];
    return JSON.stringify({
      version: '1.2',
      containerFound: !!root,
      tileCount: tiles.length,
      tiles: tiles.slice(0, 6).map((t) => {
        const texts = [];
        const w = document.createTreeWalker(t, NodeFilter.SHOW_TEXT);
        for (let n = w.nextNode(); n; n = w.nextNode()) {
          const e = n.parentElement;
          if (!e || !n.nodeValue.trim()) continue;
          texts.push({
            text: shape(n.nodeValue),
            tag: e.tagName,
            cls: String(e.className || '').slice(0, 60),
            font: (getComputedStyle(e).fontFamily || '').slice(0, 30),
            inButton: !!e.closest('button,[role="button"]'),
            iconFont: isIconText(e, t),
            hidden: isHidden(e),
          });
        }
        return {
          id: String(t.getAttribute('data-participant-id')).split('/').pop(),
          selfNameAttr: t.hasAttribute('data-self-name') || !!t.querySelector('[data-self-name]'),
          extracted: shape(extractName(t) || '(none)'),
          videos: t.querySelectorAll('video').length,
          texts,
        };
      }),
    }, null, 1);
  }

  try {
    chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
      if (msg && msg.type === 'DIAG') {
        try { sendResponse(buildDiag()); }
        catch (e) { sendResponse('DIAG error: ' + (e && e.message)); }
        return;
      }
      if (msg && msg.type === 'RESET' && state && msg.meetingId === state.meetingId) {
        state = freshState(state.meetingId);
        startAt = Date.now();
        missingSince.clear();
        dirty = true;
        scheduleSync();
      }
    });
  } catch (_) {}

  const currentMeetingId = () => (location.pathname.match(MEETING_RE) || [])[1] || null;

  function tick() {
    const id = currentMeetingId();
    if (id && (!state || state.meetingId !== id)) {
      if (!initializing) loadMeeting(id);
      return;
    }
    if (!state) return;
    attachObserver();
    sync();
    flush();
  }

  window.addEventListener('pagehide', () => flush(true));

  (async () => {
    const id = currentMeetingId();
    if (id) await loadMeeting(id);
    attachObserver();
    setInterval(tick, CONFIG.tickMs);
  })();
})();