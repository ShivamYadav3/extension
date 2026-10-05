/* Meet Attendance Tracker - background service worker
 * Stateless: every message is handled against chrome.storage.local, so it is safe
 * for MV3 to suspend and restart this worker at any time.
 */
const MEETING_ID_RE = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/;
const keyFor = (id) => `meeting:${id}`;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

async function pruneOld() {
  const all = await chrome.storage.local.get(null);
  const cutoff = Date.now() - RETENTION_MS;
  const stale = Object.entries(all)
    .filter(([k, v]) => k.startsWith('meeting:') && (v?.lastSeen || 0) < cutoff)
    .map(([k]) => k);
  if (stale.length) await chrome.storage.local.remove(stale);
}
chrome.runtime.onInstalled.addListener(pruneOld);
chrome.runtime.onStartup.addListener(pruneOld);

async function handle(msg, sender) {
  switch (msg && msg.type) {
    case 'SYNC': {
      // Only accept snapshots coming from a Meet tab.
      if (!sender.url || !sender.url.startsWith('https://meet.google.com/')) return { ok: false };
      if (!MEETING_ID_RE.test(msg.meetingId) || !msg.state || typeof msg.state !== 'object') {
        return { ok: false };
      }
      await chrome.storage.local.set({
        [keyFor(msg.meetingId)]: msg.state,
        lastMeeting: msg.meetingId,
      });
      return { ok: true };
    }

    case 'GET_STATE': {
      let id = msg.meetingId;
      if (!MEETING_ID_RE.test(id || '')) {
        id = (await chrome.storage.local.get('lastMeeting')).lastMeeting;
      }
      if (!id) return { state: null };
      const data = await chrome.storage.local.get(keyFor(id));
      return { state: data[keyFor(id)] || null };
    }

    case 'CLEAR': {
      if (!MEETING_ID_RE.test(msg.meetingId || '')) return { ok: false };
      await chrome.storage.local.remove(keyFor(msg.meetingId));
      const tabs = await chrome.tabs.query({ url: 'https://meet.google.com/*' });
      await Promise.all(
        tabs.map((t) =>
          chrome.tabs.sendMessage(t.id, { type: 'RESET', meetingId: msg.meetingId }).catch(() => null)
        )
      );
      return { ok: true };
    }

    default:
      return { ok: false };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handle(msg, sender)
    .then(sendResponse)
    .catch((err) => sendResponse({ ok: false, error: String(err) }));
  return true; // keep the channel open for the async response
});
