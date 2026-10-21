# Summit Order Tracking

Electron + TypeScript + React desktop app that reads order emails over IMAP and shows a dashboard of every order's status: ordered, shipped, out for delivery, delivered, cancelled, returned, plus "still active" (anything not delivered/cancelled/returned).


<img width="746" height="855" alt="image" src="https://github.com/user-attachments/assets/f7564600-533d-4849-bae8-e3b776662697" />


## Run

```bash
npm install
npm run dev        # dev mode with hot reload
npm run build && npm start   # production build
npm test           # parser unit tests
```

First launch opens the account screen. Pick a preset (Gmail, Outlook, Yahoo, iCloud) or enter host/port manually, **Test connection**, then **Add account**. It syncs automatically; after that hit **Sync**.

**Multiple inboxes:** click **Accounts → + Add another account**. Sync pulls from every account in turn (one failing doesn't block the rest), and the same order found in two inboxes is merged into one row. Use the account dropdown on the dashboard to see one inbox at a time. Removing an account removes orders that only came from it.

> Gmail, Yahoo and iCloud require an **app password** (2FA must be on). Your normal password will fail.

## How it works

```
IMAP (imapflow) ──► subject prefilter ──► full fetch + mailparser ──► parser.ts ──► mergeIntoOrders ──► JSON store ──► React dashboard
```

1. **Sync** (`src/main/imap.ts`): searches the mailbox for messages from the last N days, skips UIDs already processed, fetches envelopes only, and downloads full bodies just for subjects that look order-related.
2. **Parse** (`src/main/parser.ts`): pure functions, no Electron deps.
   - Status from subject first, then strict body phrases (so "to cancel your subscription" footers don't mark a shipped order as cancelled).
   - Order number: Amazon format, `Order #…`, `Order number: …`, `#…`.
   - Tracking: UPS (`1Z…`), USPS (`92…`–`95…`), Amazon (`TBA…`), FedEx/DHL via "Tracking number:" labels.
   - Retailer from sender name, falling back to the domain.
3. **Merge**: emails are grouped by `retailer:orderNumber`. Status is the most advanced event seen (cancelled > returned > delivered > out for delivery > shipped > ordered). Idempotent per Message-ID.
4. **Store** (`src/main/store.ts`): one JSON file in Electron's `userData` dir, written atomically. Every save keeps the previous version as `.bak`, plus a daily copy in `backups/` (last 14 days). An unreadable file is never overwritten: it's kept as `.unreadable-*.json` and the newest good backup is restored. The IMAP password is encrypted with `safeStorage` (macOS Keychain / Windows DPAPI / libsecret) and never sent to the renderer.

## Dashboard

- **Date range:** Today · This week (since Sunday) · This month · All time, by order date. Tiles, Active value and the table all follow it; the choice is remembered, and a notice shows how many orders it's hiding.
- **Order numbers are covered** (`••••89`) by default, including in the timeline's email subjects. The **Order #s** toggle (eye icon) in the toolbar reveals them all; the choice is remembered. Search still matches the full number.
- **Summary** opens a card over the dashboard: total spent (cancelled/returned orders excluded) inside a ring showing each store's share, and your top 3 stores with their share of the total, following the date range and account filter. Stores outside the top 3 are the gray slice. **Copy image** puts the card on the clipboard as a picture, ready to paste into Discord or X. Close it with ×, Esc or a click outside. For Target and Pokémon Center the stores show item counts (the email's `Qty:` lines added up; an order keeps the largest count from any of its emails).
- KPI tiles double as filters. "Still active" flags orders with no update in 14+ days.
- **Bulk edit:** tick the checkboxes (shift-click for a range, header box for all visible rows), then pick a status and **Apply**, or **Remove**. *Auto (from emails)* drops manual overrides and goes back to what the emails say.
- Click an order for its timeline, a carrier tracking link, and a status override. Manual statuses are marked with `•` and won't be overwritten by future syncs.
- **Find missing:** type a store or sender (e.g. `pokemon`). It searches every folder of every account (including spam/Bulk) and says, per email, whether it's tracked, in a folder that isn't synced (one click adds it), or skipped by the parser and why. **Copy report** gives you something to paste when asking for a parser fix.
- **Reset** clears all orders and the seen-UID cache so the next sync rescans everything.

## Project layout

```
src/
  shared/types.ts        types + Api contract shared by all three layers
  main/index.ts          window + IPC handlers
  main/imap.ts           IMAP sync
  main/parser.ts         email -> order logic (unit tested)
  main/store.ts          JSON persistence + encrypted password
  preload/index.ts       contextBridge window.api
  renderer/src/          React UI (App, Accounts, AccountForm, Dashboard)
tests/parser.test.ts
```

## Extending

- Parser fixes apply automatically: bump `PARSER_VERSION` in `parser.ts` and the next sync re-checks every inbox (no Reset, manual statuses kept).
- **New retailer format not detected?** Run Find missing first, then add a regex to `ORDER_PATTERNS` or `STATUS_RULES` in `parser.ts`, add a test case with a real subject line, run `npm test`.
- **Gmail tip:** set mailbox to `[Gmail]/All Mail` to include archived emails.
- **Packaging an installer:** add `electron-builder` and a `"build"` config; the code needs no changes.
