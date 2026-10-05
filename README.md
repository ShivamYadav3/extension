# Meet Attendance Tracker

Chrome / Edge (Manifest V3) extension for Google Meet. It records join and leave times, camera-on time, and how many Meet sessions share the same display name. It does **not** collect email addresses or phone numbers.

Works on Chrome or Edge on Mac, Windows, or Linux.

## Load unpacked

1. Open `chrome://extensions` (or `edge://extensions`).
2. Enable **Developer mode**.
3. Click **Load unpacked** and select this folder (the one with `manifest.json`).
4. Join a meeting at `https://meet.google.com/xxx-xxxx-xxx`.
5. Open the **People** panel so participant tiles are in the DOM.
6. Click the extension icon.

After you change code: **Reload** the extension, then **refresh the Meet tab**. If an old fake name like `frame_person` is stored, click **Clear this meeting**.

## Popup

| Column | Meaning |
| --- | --- |
| Name | Display name (click for full history) |
| Total Time in Meeting | Time present, overlapping devices counted once |
| Total Camera On Time | Time a playing `<video>` was in their tile |
| Active Devices | How many Meet session ids for that name are in the call now |

Click a name to see:

- First seen / last left
- Time away after leaving
- Each visit: joined, left, duration, away until they returned
- Device session ids (`devices/…` from Meet — not Mac vs Windows; Meet does not expose OS)

**Export CSV** includes the same fields plus a join/leave log.

## Privacy

- Keys are Meet `data-participant-id` values (per-meeting device/session ids).
- Names with `@` or 7+ digits are dropped.
- Material icon labels such as `frame_person` are ignored.
- Data stays in `chrome.storage.local` on this browser profile (kept ~7 days).

## Limits

- Meet class names (`.Ge9Kpc.z38b6`) can change; if tracking stops, re-inspect the People list.
- Camera-on means a live video element in the tile (screen share can count).
- People already in the call when tracking starts are marked; first seen may not be the true join time.
