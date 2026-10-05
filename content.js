/* Meet Attendance Tracker - content script
 * Observes the participant grid, records join/leave + camera intervals,
 * and ships snapshots to the background worker for persistence.
 */
(() => {
  'use strict';
  if (window.__meetAttendanceTracker) return;
  window.__meetAttendanceTracker = true;

  // ---------------------------------------------------------------------------
  // Config. Meet's class names are obfuscated and change without notice, so every
  // selector lives here. If tracking stops working, re-inspect the DOM and update.
  // ---------------------------------------------------------------------------
  const CONFIG = {
    containerSelector: '.Ge9Kpc.z38b6', // participant container (falls back to document)
    tileSelector: '[data-participant-id]',
    // Name nodes inside a tile. Icon fonts also use .notranslate — those are skipped in extractName.
    nameSelectors: ['[data-self-name]', '.zWGUib', '[data-tooltip]', '.notranslate'],
    leaveDebounceMs: 2000,   // tile must be gone this long before we call it a "leave"
    startupGraceMs: 6000,    // after load, don't register leaves (grid is still rendering)
    resumeWindowMs: 30000,   // refresh within this window = same continuous session
    newMeetingAfterMs: 6 * 60 * 60 * 1000, // same code reused after 6h = new meeting
    tickMs: 1000,
    heartbeatMs: 5000,
    syncDebounceMs: 150,
  };

  const MEETING_RE = /^\/([a-z]{3}-[a-z]{4}-[a-z]{3})\/?$/;

  // ---------------------------------------------------------------------------
  // State (mirrors what is stored in chrome.storage.local via the background)
  // {
  //   meetingId, startedAt, lastSeen,
  //   participants: { [participantId]: {
  //     id, name, joinedBeforeTracking,
  //     sessions: [{s, e|null}],   // in-meeting intervals
  //     cam:      [{s, e|null}]    // camera-on intervals
  //   } }
  // }
  // ---------------------------------------------------------------------------
  let state = null;
  let dirty = false;
  let initializing = false;
  let startAt = Date.now();
  let lastHeartbeat = 0;
  let observer = null;
  let observedTarget = null;
  let syncTimer = null;
  const missingSince = new Map(); // participantId -> first time its tile was missing

  // ---------------------------------------------------------------------------
  // Privacy helpers: never keep anything that looks like an email or phone number.
  // ---------------------------------------------------------------------------
  // Material / Google Symbols ligatures that Meet puts in the DOM as text.
  const ICON_NAMES = new Set([
    'frame_person', 'person', 'person_off', 'account_circle', 'face',
    'mic', 'mic_off', 'mic_none', 'headset', 'headset_mic',
    'videocam', 'videocam_off', 'video_camera_front', 'video_camera_back',
    'present_to_all', 'cancel_presentation', 'screen_share', 'stop_screen_share',
    'more_vert', 'more_horiz', 'close', 'check', 'done', 'arrow_drop_down',
    'volume_up', 'volume_off', 'call', 'call_end', 'chat', 'chat_bubble',
    'push_pin', 'keep', 'keep_off', 'hand_gesture', 'waving_hand',
    'mood', 'add', 'remove', 'search', 'settings', 'devices',
  ]);

  function isIconName(s) {
    if (!s) return false;
    const n = s.toLowerCase().replace(/\s+/g, '_');
    if (ICON_NAMES.has(n)) return true;
    // Typical ligature: frame_person, video_camera_front
    if (/^[a-z]+(_[a-z0-9]+){1,4}$/.test(n) && n === s) return true;
    return false;
  }

  function isPlaceholderName(s) {
    return !s || isIconName(s) || /^Participant\s/i.test(s);
  }

  function sanitizeName(raw) {
    if (!raw) return null;
    let s = String(raw).replace(/\s+/g, ' ').trim();
    s = s.replace(/\s*\((you|toi|tú|du)\)$/i, '').trim();
    if (/^you$/i.test(s)) return null; // wait for a real name if possible
    // aria-label often: "Ada Lovelace, camera on, microphone off"
    const comma = s.split(',')[0].trim();
    if (comma && !isIconName(comma)) s = comma;
    if (!s || s.length > 80) return null;
    if (s.includes('@')) return null;
    if ((s.match(/\d/g) || []).length >= 7) return null;
    if (isIconName(s)) return null;
    return s;
  }

  const fallbackName = (pid) => `Participant ${String(pid).split('/').pop().slice(-6)}`;

  function isIconEl(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.getAttribute('aria-hidden') === 'true') return true;
    const cls = el.className && String(el.className);
    if (cls && /google-symbols|material-icons|gm-icon|notranslate.*icon|icon.*notranslate/i.test(cls)) {
      return true;
    }
    const family = (getComputedStyle(el).fontFamily || '').toLowerCase();
    if (/material|google symbols|google-symbols/.test(family)) return true;
    return false;
  }

  // ---------------------------------------------------------------------------
  // Small interval helpers
  // ---------------------------------------------------------------------------
  const lastOf = (list) => list[list.length - 1];

  function openIfNone(list, at, extra) {
    const last = lastOf(list);
    if (last && last.e === null) {
      if (extra && extra.device && last.device !== extra.device) {
        last.device = extra.device;
        return true;
      }
      return false;
    }
    list.push({ s: at, e: null, ...extra });
    return true;
  }

  function closeOpen(list, at) {
    const last = lastOf(list);
    if (!last || last.e !== null) return false;
    last.e = Math.max(at, last.s);
    return true;
  }

  function closeAllOpen(st, at) {
    for (const p of Object.values(st.participants)) {
      closeOpen(p.sessions, at);
      closeOpen(p.cam, at);
    }
  }

  const freshState = (id) => ({
    meetingId: id,
    startedAt: Date.now(),
    lastSeen: Date.now(),
    participants: {},
  });

  // ---------------------------------------------------------------------------
  // DOM inspection
  // ---------------------------------------------------------------------------
  function isHidden(el) {
    if (el.hidden) return true;
    if (el.getClientRects().length === 0) return true; // display:none on self or ancestor
    const cs = getComputedStyle(el);
    return cs.display === 'none' || cs.visibility === 'hidden';
  }

  function extractName(tile) {
    const fromAttr = sanitizeName(tile.getAttribute('data-self-name'));
    if (fromAttr) return fromAttr;

    const fromAria = sanitizeName(tile.getAttribute('aria-label'));
    if (fromAria) return fromAria;

    for (const el of tile.querySelectorAll('[data-self-name]')) {
      const name = sanitizeName(el.getAttribute('data-self-name') || el.textContent);
      if (name) return name;
    }

    for (const sel of CONFIG.nameSelectors) {
      for (const el of tile.querySelectorAll(sel)) {
        if (isIconEl(el)) continue;
        const name = sanitizeName(el.getAttribute('data-self-name') || el.getAttribute('data-tooltip') || el.textContent);
        if (name) return name;
      }
    }
    return null;
  }

  function localDeviceName() {
    const ua = navigator.userAgent || '';
    const platform = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '';
    let os = 'Computer';
    if (/iPhone/i.test(ua)) os = 'iPhone';
    else if (/iPad/i.test(ua)) os = 'iPad';
    else if (/Android/i.test(ua)) os = 'Android';
    else if (/Mac/i.test(platform) || /Mac OS/i.test(ua)) os = 'Mac';
    else if (/Win/i.test(platform) || /Windows/i.test(ua)) os = 'Windows';
    else if (/Linux/i.test(platform) || /Linux/i.test(ua)) os = 'Linux';
    let browser = 'Browser';
    if (/Edg\//i.test(ua)) browser = 'Edge';
    else if (/Chrome\//i.test(ua)) browser = 'Chrome';
    else if (/Firefox\//i.test(ua)) browser = 'Firefox';
    else if (/Safari/i.test(ua) && !/Chrome/i.test(ua)) browser = 'Safari';
    return `${browser} on ${os}`;
  }

  function extractDevice(tile) {
    const parts = [
      tile.getAttribute('aria-label') || '',
      tile.getAttribute('data-tooltip') || '',
      tile.getAttribute('title') || '',
    ];
    for (const el of tile.querySelectorAll('[data-tooltip], [title], .Nko5Ue, .Nko5Ve')) {
      if (isIconEl(el)) continue;
      const t = (el.getAttribute('data-tooltip') || el.getAttribute('title') || el.textContent || '').trim();
      if (t && t.length < 48) parts.push(t);
    }
    const blob = parts.join(' ');
    const rules = [
      [/iphone/i, 'iPhone'],
      [/ipad/i, 'iPad'],
      [/android/i, 'Android'],
      [/\bwindows\b/i, 'Windows'],
      [/\bmacintosh\b|\bmac os\b|\bmac\b/i, 'Mac'],
      [/\btablet\b/i, 'Tablet'],
      [/\bphone\b|\bmobile\b/i, 'Phone'],
    ];
    for (const [re, label] of rules) {
      if (re.test(blob)) return label;
    }
    const self = tile.hasAttribute('data-self-name')
      || tile.querySelector('[data-self-name]')
      || /\(you\)|\byou\b/i.test(tile.getAttribute('aria-label') || '');
    if (self) return localDeviceName();
    return null;
  }

  // Camera counts as "on" only when a visible <video> is actually playing frames.
  // readyState >= 2 (HAVE_CURRENT_DATA) is used instead of strictly 4 because live
  // WebRTC streams routinely sit at 2-3 and would otherwise flap.
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
  // Core reconcile: compare DOM against state, record changes.
  // ---------------------------------------------------------------------------
  function sync() {
    if (!state) return;
    const now = Date.now();
    const root = document.querySelector(CONFIG.containerSelector) || document;

    const seen = new Map(); // pid -> {name, cam}
    for (const tile of root.querySelectorAll(CONFIG.tileSelector)) {
      const pid = tile.getAttribute('data-participant-id');
      if (!pid || pid.length > 200 || pid.includes('@')) continue;
      if (isHidden(tile)) continue;
      const entry = seen.get(pid) || { name: null, cam: false, device: null };
      entry.name = entry.name || extractName(tile);
      entry.device = entry.device || extractDevice(tile);
      entry.cam = entry.cam || isCameraOn(tile);
      seen.set(pid, entry);
    }

    const firstBatch = Object.keys(state.participants).length === 0;

    // Present participants: joins, renames, camera transitions
    for (const [pid, info] of seen) {
      missingSince.delete(pid);
      let p = state.participants[pid];
      if (!p) {
        p = state.participants[pid] = {
          id: pid,
          name: info.name || fallbackName(pid),
          deviceHint: info.device || null,
          joinedBeforeTracking: firstBatch,
          sessions: [],
          cam: [],
        };
        dirty = true;
      }
      const nextName = info.name || (isPlaceholderName(p.name) ? fallbackName(pid) : null);
      if (nextName && p.name !== nextName) { p.name = nextName; dirty = true; }
      if (info.device && p.deviceHint !== info.device) { p.deviceHint = info.device; dirty = true; }
      if (openIfNone(p.sessions, now, { device: info.device || p.deviceHint || null })) dirty = true;
      if (info.cam) {
        if (openIfNone(p.cam, now)) dirty = true;
      } else if (closeOpen(p.cam, now)) {
        dirty = true;
      }
    }

    // Missing participants: leaves (debounced so re-renders don't cause fake leaves)
    if (now - startAt >= CONFIG.startupGraceMs) {
      for (const p of Object.values(state.participants)) {
        if (seen.has(p.id)) continue;
        const open = lastOf(p.sessions);
        if (!open || open.e !== null) continue;

        const since = missingSince.get(p.id) ?? now;
        missingSince.set(p.id, since);
        if (closeOpen(p.cam, since)) dirty = true; // no tile = no camera
        if (now - since >= CONFIG.leaveDebounceMs) {
          closeOpen(p.sessions, since);            // leave time = when the tile vanished
          missingSince.delete(p.id);
          dirty = true;
        }
      }
    }

    if (now - lastHeartbeat >= CONFIG.heartbeatMs) {
      state.lastSeen = now;
      lastHeartbeat = now;
      dirty = true;
    }
  }

  const scheduleSync = () => {
    if (syncTimer) return;
    syncTimer = setTimeout(() => { syncTimer = null; sync(); }, CONFIG.syncDebounceMs);
  };

  // ---------------------------------------------------------------------------
  // Observer wiring
  // ---------------------------------------------------------------------------
  function attachObserver() {
    const target = document.querySelector(CONFIG.containerSelector) || document.body;
    if (!target || target === observedTarget) return;
    if (observer) observer.disconnect();
    if (observedTarget) {
      for (const ev of ['play', 'pause', 'emptied', 'loadeddata']) {
        observedTarget.removeEventListener(ev, scheduleSync, true);
      }
    }
    observer = new MutationObserver(scheduleSync);
    observer.observe(target, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['style', 'class', 'hidden'], // catches display:none "soft leaves"
    });
    // Media events don't bubble, so capture them on the container.
    for (const ev of ['play', 'pause', 'emptied', 'loadeddata']) {
      target.addEventListener(ev, scheduleSync, true);
    }
    observedTarget = target;
  }

  // ---------------------------------------------------------------------------
  // Messaging
  // ---------------------------------------------------------------------------
  function send(msg) {
    try {
      return chrome.runtime.sendMessage(msg).catch(() => null);
    } catch (_) {
      return Promise.resolve(null); // extension reloaded; old content script is orphaned
    }
  }

  function flush(force = false) {
    if (!state || !(dirty || force)) return;
    dirty = false;
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
        // else: quick refresh -> keep sessions open, they continue seamlessly
      }
      state = st || freshState(id);
      startAt = Date.now();
      missingSince.clear();
      dirty = true;
    } finally {
      initializing = false;
    }
  }

  try {
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg && msg.type === 'RESET' && state && msg.meetingId === state.meetingId) {
        state = freshState(state.meetingId);
        startAt = Date.now();
        missingSince.clear();
        dirty = true;
        scheduleSync();
      }
    });
  } catch (_) { /* context invalidated */ }

  // ---------------------------------------------------------------------------
  // Main loop
  // ---------------------------------------------------------------------------
  function tick() {
    const id = (location.pathname.match(MEETING_RE) || [])[1] || null;
    if (id && (!state || state.meetingId !== id)) {
      if (!initializing) loadMeeting(id);
      return;
    }
    if (!state) return;
    attachObserver();
    sync(); // safety net: video state and soft-hides don't always trigger mutations
    flush();
  }

  window.addEventListener('pagehide', () => flush(true)); // don't close sessions: refresh resumes them

  (async () => {
    const id = (location.pathname.match(MEETING_RE) || [])[1] || null;
    if (id) await loadMeeting(id);
    attachObserver();
    setInterval(tick, CONFIG.tickMs);
  })();
})();
