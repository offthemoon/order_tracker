import { app, safeStorage } from 'electron'
import { randomUUID } from 'crypto'
import { promises as fs } from 'fs'
import { basename, join } from 'path'
import type { ImapAccount, Order, PublicAccount } from '../shared/types'
import { repairOrderNumbers } from './parser'

interface StoredAccount extends Omit<ImapAccount, 'password'> {
  /** base64 of safeStorage-encrypted password (OS keychain-backed). */
  passwordEnc?: string
}

interface DB {
  accounts: StoredAccount[]
  orders: Order[]
  /** IMAP UIDs already processed, keyed by `${user}|${mailbox}|${uidValidity}` */
  seen: Record<string, number[]>
  /** v1 single-account field, migrated on load. */
  settings?: Omit<StoredAccount, 'id'> | null
}

const dir = () => app.getPath('userData')
const file = () => join(dir(), 'order-tracker.json')
const bakFile = () => file() + '.bak'
const backupDir = () => join(dir(), 'backups')
const KEEP_DAILY = 14
let cache: DB | null = null
/** One-time message for the UI when data had to be recovered. */
let notice: string | null = null

const isMissing = (e: unknown) => (e as NodeJS.ErrnoException)?.code === 'ENOENT'

async function readDB(path: string): Promise<DB> {
  const db = JSON.parse(await fs.readFile(path, 'utf8')) as DB
  if (!db || typeof db !== 'object' || !Array.isArray(db.orders ?? [])) throw new Error('not a Summit Order Tracking file')
  return db
}

/** Newest-first list of backups to try when the main file is unusable. */
async function backupCandidates(): Promise<string[]> {
  let daily: string[] = []
  try {
    daily = (await fs.readdir(backupDir())).filter(f => f.endsWith('.json')).sort().reverse().map(f => join(backupDir(), f))
  } catch { /* no backups yet */ }
  return [bakFile(), ...daily]
}

async function load(): Promise<DB> {
  if (cache) return cache
  try {
    cache = await readDB(file())
  } catch (e) {
    // Never start empty over a file we couldn't read: that would wipe it on the next save.
    if (!isMissing(e)) {
      const kept = file().replace(/\.json$/, `.unreadable-${Date.now()}.json`)
      await fs.rename(file(), kept).catch(() => {})
      console.error('[store] could not read data file, kept a copy at', kept, e)
    }
    for (const b of await backupCandidates()) {
      try {
        cache = await readDB(b)
        if (!isMissing(e)) notice = `Your data file couldn't be read, so it was restored from a backup (${basename(b)}). Sync to pull in anything newer.`
        else if (b) notice = `Your data file was missing, so it was restored from a backup (${basename(b)}).`
        break
      } catch { /* try the next one */ }
    }
    if (cache) await save() // write the recovered data back as the main file
    cache ??= { accounts: [], orders: [], seen: {} }
  }
  cache.seen ??= {}
  cache.accounts ??= []
  cache.orders ??= []
  // Migrate v1 (single `settings`) -> v2 (`accounts[]`), tagging existing orders with that account.
  if (cache.settings) {
    const id = randomUUID()
    cache.accounts.push({ ...cache.settings, id })
    cache.orders = cache.orders.map(o => ({
      ...o,
      accounts: o.accounts?.length ? o.accounts : [id],
      events: o.events.map(ev => ({ ...ev, account: ev.account ?? id }))
    }))
    delete cache.settings
    await save()
  }
  // Fix order numbers saved by older parser versions (merges split orders).
  const repaired = repairOrderNumbers(cache.orders)
  if (repaired !== cache.orders) {
    cache.orders = repaired
    await save()
  }
  return cache
}

async function save(): Promise<void> {
  if (!cache) return
  await backup()
  const tmp = file() + '.tmp'
  await fs.writeFile(tmp, JSON.stringify(cache, null, 2), 'utf8')
  await fs.rename(tmp, file()) // atomic replace
}

/**
 * Before every write: previous file -> .bak. Once a day: a dated copy in
 * backups/ (last 14 kept). Only copies files that parse, so a bad file never
 * replaces a good backup.
 */
async function backup(): Promise<void> {
  try {
    await readDB(file())
  } catch {
    return // nothing (valid) to back up yet
  }
  await fs.copyFile(file(), bakFile()).catch(() => {})
  const day = new Date().toISOString().slice(0, 10)
  const daily = join(backupDir(), `order-tracker-${day}.json`)
  try {
    await fs.access(daily)
  } catch {
    await fs.mkdir(backupDir(), { recursive: true }).catch(() => {})
    await fs.copyFile(file(), daily).catch(() => {})
    const all = (await fs.readdir(backupDir()).catch(() => [] as string[])).filter(f => f.endsWith('.json')).sort()
    for (const old of all.slice(0, Math.max(0, all.length - KEEP_DAILY))) await fs.unlink(join(backupDir(), old)).catch(() => {})
  }
}

/** Returns the recovery message once, then clears it. */
export async function takeNotice(): Promise<string | null> {
  await load()
  const n = notice
  notice = null
  return n
}

export const dataFolder = () => dir()

const toPublic = ({ passwordEnc, ...rest }: StoredAccount): PublicAccount => ({ ...rest, hasPassword: !!passwordEnc })
const decrypt = ({ passwordEnc, ...rest }: StoredAccount): ImapAccount => ({
  ...rest,
  password: passwordEnc ? safeStorage.decryptString(Buffer.from(passwordEnc, 'base64')) : undefined
})

export async function getPublicAccounts(): Promise<PublicAccount[]> {
  return (await load()).accounts.map(toPublic)
}

export async function getFullAccounts(): Promise<ImapAccount[]> {
  return (await load()).accounts.map(decrypt)
}

export async function getFullAccount(id: string): Promise<ImapAccount | null> {
  const a = (await load()).accounts.find(x => x.id === id)
  return a ? decrypt(a) : null
}

export async function saveAccount(input: ImapAccount): Promise<PublicAccount[]> {
  const db = await load()
  const { password, ...rest } = input
  if (password && !safeStorage.isEncryptionAvailable()) {
    throw new Error('OS encryption (keychain) is not available; refusing to store password in plain text.')
  }
  const existing = input.id ? db.accounts.find(a => a.id === input.id) : undefined
  const dupe = db.accounts.find(a => a.id !== input.id && a.user.toLowerCase() === input.user.toLowerCase() && a.mailbox === input.mailbox && a.host === input.host)
  if (dupe) throw new Error(`${input.user} (${input.mailbox}) is already added.`)
  // Empty password on edit means "keep the existing one".
  const passwordEnc = password ? safeStorage.encryptString(password).toString('base64') : existing?.passwordEnc
  if (!passwordEnc) throw new Error('Password is required.')
  const record: StoredAccount = { ...rest, id: existing?.id ?? randomUUID(), passwordEnc }
  db.accounts = existing ? db.accounts.map(a => (a.id === existing.id ? record : a)) : [...db.accounts, record]
  await save()
  return db.accounts.map(toPublic)
}

/** Removes the account and its seen-UID cache. Caller handles orders. */
export async function deleteAccount(id: string): Promise<PublicAccount[]> {
  const db = await load()
  const a = db.accounts.find(x => x.id === id)
  if (a) {
    const prefix = `${a.user}|` // covers the main folder and any extra folders
    for (const k of Object.keys(db.seen)) if (k.startsWith(prefix)) delete db.seen[k]
  }
  db.accounts = db.accounts.filter(x => x.id !== id)
  await save()
  return db.accounts.map(toPublic)
}

export async function getOrders(): Promise<Order[]> {
  return (await load()).orders
}

export async function setOrders(orders: Order[]): Promise<void> {
  ;(await load()).orders = orders
  await save()
}

export async function getSeen(key: string): Promise<Set<number>> {
  return new Set((await load()).seen[key] ?? [])
}

export async function setSeen(key: string, uids: Set<number>): Promise<void> {
  ;(await load()).seen[key] = [...uids]
  await save()
}

/** Drop stale caches for a folder (older parser versions / UIDVALIDITY). */
export async function pruneSeen(prefix: string, keep: string): Promise<void> {
  const db = await load()
  let changed = false
  for (const k of Object.keys(db.seen)) if (k.startsWith(prefix) && k !== keep) { delete db.seen[k]; changed = true }
  if (changed) await save()
}

export async function addFolder(accountId: string, folder: string): Promise<PublicAccount[]> {
  const db = await load()
  const a = db.accounts.find(x => x.id === accountId)
  if (!a) throw new Error('Account not found.')
  if (a.mailbox !== folder && !(a.extraMailboxes ?? []).includes(folder)) a.extraMailboxes = [...(a.extraMailboxes ?? []), folder]
  await save()
  return db.accounts.map(toPublic)
}

export async function clearAll(): Promise<void> {
  const db = await load()
  db.orders = []
  db.seen = {}
  await save()
}
