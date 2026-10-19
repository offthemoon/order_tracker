import { ImapFlow } from 'imapflow'
import { simpleParser } from 'mailparser'
import type { AccountSyncResult, DiagnoseHit, DiagnoseResult, ImapAccount, SyncProgress, SyncResult } from '../shared/types'
import { parseEmail, explainEmail, mergeIntoOrders, PARSER_VERSION, SUBJECT_HINT, type ParsedEmail, type RawEmail } from './parser'
import * as store from './store'

const BATCH = 25

function client(s: ImapAccount): ImapFlow {
  if (!s.password) throw new Error('No password saved')
  return new ImapFlow({
    host: s.host,
    port: s.port,
    secure: s.secure,
    auth: { user: s.user, pass: s.password },
    logger: false,
    socketTimeout: 60_000
  })
}

export async function testConnection(s: ImapAccount): Promise<{ ok: boolean; error?: string }> {
  let c: ImapFlow | null = null
  try {
    c = client(s)
    await c.connect()
    const lock = await c.getMailboxLock(s.mailbox)
    lock.release()
    return { ok: true }
  } catch (e) {
    return { ok: false, error: friendlyError(e) }
  } finally {
    await c?.logout().catch(() => {})
  }
}

/** Sync every saved account, one after another. One failing account doesn't stop the others. */
export async function syncAll(onProgress: (p: SyncProgress) => void): Promise<SyncResult> {
  const accounts = await store.getFullAccounts()
  if (!accounts.length) return { scanned: 0, matched: 0, orders: 0, accounts: [], error: 'Add an email account first.' }

  const results: AccountSyncResult[] = []
  for (const [i, acct] of accounts.entries()) {
    const r = await syncAccount(acct, (done, total) =>
      onProgress({ account: acct.user, index: i + 1, count: accounts.length, done, total }))
    results.push(r)
  }
  const failed = results.filter(r => r.error)
  return {
    scanned: results.reduce((n, r) => n + r.scanned, 0),
    matched: results.reduce((n, r) => n + r.matched, 0),
    orders: (await store.getOrders()).length,
    accounts: results,
    error: failed.length ? failed.map(r => `${r.user}: ${r.error}`).join(' · ') : undefined
  }
}

export const foldersOf = (a: ImapAccount) => [...new Set([a.mailbox, ...(a.extraMailboxes ?? [])].filter(Boolean))]

async function syncAccount(s: ImapAccount, onProgress: (done: number, total: number) => void): Promise<AccountSyncResult> {
  const base = { accountId: s.id, user: s.user }
  const parsed: ParsedEmail[] = []
  let scanned = 0
  let c: ImapFlow | null = null
  try {
    c = client(s)
    await c.connect()
    const folders = foldersOf(s)
    const errors: string[] = []
    for (const folder of folders) {
      try {
        scanned += await syncFolder(c, s, folder, parsed, onProgress)
      } catch (e) {
        // A missing extra folder shouldn't block the main one.
        if (folder === s.mailbox) throw e
        errors.push(`folder "${folder}": ${friendlyError(e)}`)
      }
    }
    return { ...base, scanned, matched: parsed.length, error: errors.length ? errors.join(', ') : undefined }
  } catch (e) {
    return { ...base, scanned, matched: parsed.length, error: friendlyError(e) }
  } finally {
    await c?.logout().catch(() => {})
  }
}

async function syncFolder(
  c: ImapFlow, s: ImapAccount, folder: string, parsed: ParsedEmail[],
  onProgress: (done: number, total: number) => void
): Promise<number> {
  const lock = await c.getMailboxLock(folder, { readOnly: true })
  try {
    const mb = c.mailbox
    const prefix = `${s.user}|${folder}|`
    // Keyed on parser version: improved rules re-check mail automatically.
    const seenKey = `${prefix}${mb ? String(mb.uidValidity) : '0'}|v${PARSER_VERSION}`
    const seen = await store.getSeen(seenKey)

    const since = new Date(Date.now() - s.lookbackDays * 86_400_000)
    const all = (await c.search({ since }, { uid: true })) || []
    const fresh = all.filter(uid => !seen.has(uid))

    // Pass 1: envelopes only, filter by subject.
    const candidates: number[] = []
    if (fresh.length) {
      for await (const msg of c.fetch(fresh.join(','), { envelope: true, uid: true }, { uid: true })) {
        if (SUBJECT_HINT.test(msg.envelope?.subject ?? '')) candidates.push(msg.uid)
        else seen.add(msg.uid)
      }
    }

    // Pass 2: full source for candidates, in batches.
    const found: ParsedEmail[] = []
    onProgress(0, candidates.length)
    for (let i = 0; i < candidates.length; i += BATCH) {
      const chunk = candidates.slice(i, i + BATCH)
      for await (const msg of c.fetch(chunk.join(','), { source: true, uid: true }, { uid: true })) {
        if (!msg.source) continue
        const p = parseEmail(await toRawEmail(msg.source, `${seenKey}:${msg.uid}`))
        if (p) found.push({ ...p, account: s.id })
        seen.add(msg.uid)
      }
      onProgress(Math.min(i + BATCH, candidates.length), candidates.length)
    }

    // Save per folder so a later failure doesn't lose this one's work.
    await store.setOrders(mergeIntoOrders(await store.getOrders(), found))
    await store.setSeen(seenKey, seen)
    await store.pruneSeen(prefix, seenKey)
    parsed.push(...found)
    return fresh.length
  } finally {
    lock.release()
  }
}

async function toRawEmail(source: Buffer, fallbackId: string): Promise<RawEmail> {
  const mail = await simpleParser(source)
  const from = mail.from?.value[0]
  return {
    messageId: mail.messageId || fallbackId,
    date: mail.date ?? new Date(),
    fromName: from?.name ?? '',
    fromAddress: from?.address ?? '',
    subject: mail.subject ?? '',
    text: mail.text || (typeof mail.html === 'string' ? htmlToText(mail.html) : '')
  }
}

// ---------- "Find missing orders" ----------
const DIAG_MAX_PER_ACCOUNT = 40
/** Folders where order mail never lives. */
const SKIP_FOLDER_FLAGS = new Set(['\\Sent', '\\Drafts', '\\Noselect', '\\NonExistent'])

/**
 * Searches every folder of every account for emails whose sender or subject
 * contains `term`, and explains what sync does with each one.
 */
export async function diagnose(term: string): Promise<DiagnoseResult> {
  const needle = term.trim()
  const result: DiagnoseResult = { hits: [], errors: [], foldersSearched: 0, truncated: false }
  if (needle.length < 2) return { ...result, errors: ['Type at least 2 characters.'] }

  const tracked = new Map<string, { orderNumber: string; status: string }>()
  for (const o of await store.getOrders())
    for (const ev of o.events) tracked.set(ev.messageId, { orderNumber: o.orderNumber, status: o.status })

  for (const acct of await store.getFullAccounts()) {
    let c: ImapFlow | null = null
    try {
      c = client(acct)
      await c.connect()
      const synced = new Set(foldersOf(acct))
      const since = new Date(Date.now() - acct.lookbackDays * 86_400_000)
      const folders = (await c.list()).filter(f => ![...(f.flags ?? [])].some(fl => SKIP_FOLDER_FLAGS.has(fl)) && !SKIP_FOLDER_FLAGS.has(f.specialUse ?? ''))
      const hits: { folder: string; uid: number; date: number }[] = []

      for (const f of folders) {
        const lock = await c.getMailboxLock(f.path, { readOnly: true }).catch(() => null)
        if (!lock) continue
        try {
          result.foldersSearched++
          const uids = (await c.search({ since, or: [{ from: needle }, { subject: needle }] }, { uid: true })) || []
          if (!uids.length) continue
          for await (const m of c.fetch(uids.join(','), { uid: true, internalDate: true }, { uid: true }))
            hits.push({ folder: f.path, uid: m.uid, date: new Date(m.internalDate ?? 0).getTime() })
        } catch {
          // Some servers refuse SEARCH in special folders; skip them.
        } finally {
          lock.release()
        }
      }

      hits.sort((a, b) => b.date - a.date)
      if (hits.length > DIAG_MAX_PER_ACCOUNT) result.truncated = true
      const byFolder = new Map<string, number[]>()
      for (const h of hits.slice(0, DIAG_MAX_PER_ACCOUNT)) byFolder.set(h.folder, [...(byFolder.get(h.folder) ?? []), h.uid])

      for (const [folder, uids] of byFolder) {
        const lock = await c.getMailboxLock(folder, { readOnly: true })
        try {
          for await (const m of c.fetch(uids.join(','), { source: true, uid: true }, { uid: true })) {
            if (!m.source) continue
            const raw = await toRawEmail(m.source, `${acct.user}|${folder}|${m.uid}`)
            result.hits.push(verdictFor(acct, folder, synced.has(folder), raw, tracked))
          }
        } finally {
          lock.release()
        }
      }
    } catch (e) {
      result.errors.push(`${acct.user}: ${friendlyError(e)}`)
    } finally {
      await c?.logout().catch(() => {})
    }
  }
  result.hits.sort((a, b) => b.date.localeCompare(a.date))
  return result
}

function verdictFor(
  acct: ImapAccount, folder: string, inSyncedFolder: boolean, raw: RawEmail,
  tracked: Map<string, { orderNumber: string; status: string }>
): DiagnoseHit {
  const ex = explainEmail(raw)
  const known = tracked.get(raw.messageId)
  const base = {
    accountId: acct.id,
    account: acct.user,
    folder,
    date: raw.date.toISOString(),
    from: raw.fromName ? `${raw.fromName} <${raw.fromAddress}>` : raw.fromAddress,
    subject: raw.subject,
    orderNumber: ex.orderNumber,
    status: ex.result?.status ?? ex.status,
    snippet: raw.text.replace(/\s+/g, ' ').trim().slice(0, 600)
  }
  if (known) return { ...base, verdict: 'tracked', reason: `Already tracked on order ${known.orderNumber}.` }
  if (!inSyncedFolder)
    return { ...base, verdict: 'wrong_folder', reason: `It's in "${folder}", which isn't synced for this account. ${ex.result ? 'The parser reads it fine, so syncing this folder fixes it.' : ex.reason}` }
  if (ex.result && ex.passesPrefilter) return { ...base, verdict: 'will_add', reason: `${ex.reason} It will be added on the next sync.` }
  return { ...base, verdict: 'skipped', reason: ex.reason }
}

function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|tr|li)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#36;|&dollar;/g, '$')
    .replace(/[ \t]+/g, ' ')
}

function friendlyError(e: unknown): string {
  const err = e as { authenticationFailed?: boolean; code?: string; responseText?: string; message?: string }
  if (err.authenticationFailed) return 'Login failed. For Gmail/Yahoo/iCloud/Outlook use an app password, not your normal password.'
  if (err.code === 'ENOTFOUND') return 'Server not found. Check the IMAP host.'
  if (err.code === 'ECONNREFUSED' || err.code === 'ETIMEDOUT') return 'Could not reach the server. Check host, port and SSL setting.'
  return err.responseText || err.message || String(e)
}
