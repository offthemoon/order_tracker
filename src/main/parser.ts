import type { Order, OrderEvent, OrderStatus } from '../shared/types'

/** Minimal email shape the parser needs (decoupled from IMAP/mailparser). */
export interface RawEmail {
  messageId: string
  date: Date
  fromName: string
  fromAddress: string
  subject: string
  text: string
}

export interface ParsedEmail {
  orderNumber: string
  retailer: string
  status: OrderStatus
  date: string
  subject: string
  messageId: string
  total?: string
  items?: number
  trackingNumber?: string
  carrier?: string
  account?: string
}

/**
 * Bump whenever detection rules change. Sync keys its "already scanned" cache
 * on this, so every inbox is re-checked once with the new rules (no Reset needed).
 */
export const PARSER_VERSION = 5

/** Cheap subject filter so sync only downloads full bodies of likely order emails. */
export const SUBJECT_HINT = /order|ship|deliver|cancel|refund|return|package|purchase|receipt|track|arriv|dispatch|confirm|thank|invoice|on (?:its|the) way|out for/i

// ---------- status detection ----------
// Checked top to bottom; first match wins. Subject is checked first because bodies
// often contain boilerplate like "to cancel your order click here".
const STATUS_RULES: [OrderStatus, RegExp][] = [
  ['cancelled', /\b(cancel(?:l?ed|l?ing|lation)?|couldn'?t be (?:fulfilled|processed|completed)|could not be (?:fulfilled|processed|completed)|unable to (?:fulfill|process|complete|ship) (?:your|the|this) order|order (?:was |has been )?voided)\b/i],
  ['returned', /\b(refund(?:ed)? (?:issued|processed|has been)|return (?:received|processed|complete)|your refund|refund for)\b/i],
  ['out_for_delivery', /\b(out for delivery|arriving today|will be delivered today)\b/i],
  ['delivered', /\b((?<!will be |to be |be )delivered|delivery complete|(?<!will have |should have )(?:has |have |had )?arrived|dropped off|left at your|(?:was |were |been )picked up)\b/i],
  ['shipped', /\b(shipped|has shipped|on (?:its|the) way|in transit|dispatched|shipment|tracking (?:number|info)|label created|(?:about|ready|getting ready|preparing) to ship|ships? (?:today|soon)|handed (?:off )?to (?:the )?carrier)\b/i],
  ['ordered', /\b(order (?:confirmation|confirmed|received|placed)|thank(?:s| you) for (?:your )?(?:order|purchase)|we(?:'ve| have) received your order|receipt for your order|your order #?)\b/i]
]

// Body-only rules are stricter to avoid false positives from footers.
const BODY_RULES: [OrderStatus, RegExp][] = [
  ['cancelled', /\b(your order (?:has been|was) cancel(?:l)?ed|we(?:'ve| have)? (?:had to )?cancel(?:l?ed)? (?:your|the|this) order|had to cancel|unable to (?:fulfill|process|complete) (?:your|the|this) order)\b/i],
  ['delivered', /\b(your (?:order|package|items?) (?:has been|have been|was|were) delivered|your (?:order|package|items?) (?:has|have) arrived)\b/i],
  ['out_for_delivery', /\bout for delivery\b/i],
  ['shipped', /(?<!\b(?:when|once|after|until|before) )\byour (?:order|package|item)s? (?:has|have) shipped\b|(?<!\b(?:when|once|after|until|before) (?:your |the )?(?:order|package|item)s? )\b(?:is|are) on (?:its|the|their) way\b/i]
]

/** Confirmation wording in the body, used only when nothing stronger matched. */
const BODY_ORDERED = /\b(thank(?:s| you) for (?:your )?(?:order|purchase|shopping)|order (?:confirmation|confirmed|received|placed|summary|details)|we(?:'ve| have) received your order|your order (?:has been|was) (?:placed|received))\b/i

export function detectStatus(subject: string, body: string): OrderStatus {
  // "ordered" is the weakest signal: generic subjects like "Update on your order"
  // match it, so check the body for a stronger status before falling back to it.
  for (const [status, re] of STATUS_RULES) if (status !== 'ordered' && re.test(subject)) return status
  for (const [status, re] of BODY_RULES) if (re.test(body)) return status
  for (const [status, re] of STATUS_RULES) if (status === 'ordered' && re.test(subject)) return status
  if (BODY_ORDERED.test(body)) return 'ordered'
  return 'unknown'
}

// ---------- order number ----------
const ORDER_PATTERNS: RegExp[] = [
  /\b(\d{3}-\d{7}-\d{7})\b/, // Amazon
  /order\s*(?:#|no\.?|number|num|id)\s*[:#]?\s*([A-Z0-9][A-Z0-9-]{3,29})\b/i,
  /order\s*[:#]\s*([A-Z0-9][A-Z0-9-]{3,29})\b/i,
  /\border\s+(\d[\d-]{5,29})\b/i, // "from order 912003456789" (no # sign)
  /#\s?([A-Z0-9]{0,4}\d[A-Z0-9-]{3,24})\b/i
]

/**
 * Order numbers often get glued to the next word when an email's HTML has no
 * space between tags: "#912003456789ARE about to ship" or "#912003456789Your".
 */
export function cleanOrderNumber(raw: string): string {
  let n = raw.replace(/-+$/, '')
  // Digit followed by a lowercase word ("...789are", "...789Your"): cut at the word.
  n = n.replace(/(\d)[A-Z]?[a-z]+$/, '$1')
  // Long all-digit number with letters stuck on the end ("...789ARE"): keep the digits.
  const m = n.match(/^(\d{6,})[A-Za-z]{2,}$/)
  if (m) n = m[1]
  return n.toUpperCase()
}

export function extractOrderNumber(subject: string, body: string): string | null {
  return findOrderNumber(subject, body)?.orderNumber ?? null
}

/** Order number plus where it came from; `labeled` = found next to the word "order". */
function findOrderNumber(subject: string, body: string): { orderNumber: string; labeled: boolean; where: 'subject' | 'body' } | null {
  for (const [where, src] of [['subject', subject], ['body', body]] as const) {
    for (const [i, re] of ORDER_PATTERNS.entries()) {
      const m = src.match(re)
      if (m && /\d/.test(m[1])) return { orderNumber: cleanOrderNumber(m[1]), labeled: i < ORDER_PATTERNS.length - 1, where }
    }
  }
  return null
}

// ---------- tracking ----------
/**
 * UPS numbers are 1Z + 6-char shipper code + 10 digits, the last a check digit.
 * Emails are full of random link IDs that also start with "1z", so require both.
 */
export function isValidUps(n: string): boolean {
  if (!/^1Z[0-9A-Z]{6}\d{10}$/.test(n)) return false
  const body = n.slice(2)
  let sum = 0
  for (let i = 0; i < 15; i++) {
    const c = body[i]
    const v = /\d/.test(c) ? Number(c) : (c.charCodeAt(0) - 63) % 10 // A=2, B=3 … (UPS letter values)
    sum += i % 2 ? v * 2 : v
  }
  return (10 - (sum % 10)) % 10 === Number(body[15])
}

export function extractTracking(text: string): { trackingNumber: string; carrier: string } | null {
  for (const m of text.matchAll(/\b(1Z[0-9A-Z]{6}\d{10})\b/gi)) {
    const n = m[1].toUpperCase()
    if (isValidUps(n)) return { trackingNumber: n, carrier: 'UPS' }
  }
  const usps = text.match(/\b(9[2345]\d{18,24})\b/)
  if (usps) return { trackingNumber: usps[1], carrier: 'USPS' }
  const amzl = text.match(/\b(TBA\d{9,15})\b/)
  if (amzl) return { trackingNumber: amzl[1], carrier: 'Amazon' }
  const labeled = text.match(/tracking\s*(?:number|#|no\.?)?\s*[:#]?\s*([A-Z0-9]{10,30})\b/i)
  if (labeled && /\d/.test(labeled[1])) {
    const n = labeled[1]
    const carrier = /^\d{12}$|^\d{15}$/.test(n) ? 'FedEx' : /fedex/i.test(text) ? 'FedEx' : /dhl/i.test(text) ? 'DHL' : 'Unknown'
    return { trackingNumber: n, carrier }
  }
  return null
}

// ---------- misc ----------
export function extractTotal(text: string): string | undefined {
  const m = text.match(/(?:order total|grand total|total charged|total)\s*:?\s*\$\s?([\d,]+\.\d{2})/i)
  return m ? `$${m[1]}` : undefined
}

/** Stores whose emails list one "Qty: N" line per product. */
const ITEM_COUNT_RETAILERS = /^(?:target|pok[eé]mon center)$/i

/** Total quantity across the email's product lines, or undefined if it lists none. */
export function extractItemCount(retailer: string, text: string): number | undefined {
  if (!ITEM_COUNT_RETAILERS.test(retailer)) return undefined
  let sum = 0
  for (const m of text.matchAll(/\b(?:qty|quantity)\s*:?\s*(\d{1,3})\b/gi)) sum += Number(m[1])
  return sum || undefined
}

const GENERIC_SENDER = /^(no-?reply|do-?not-?reply|orders?|shipping|ship-confirm|auto-confirm|notifications?|info|support|updates?|store-news|mail|email)$/i

export function extractRetailer(fromName: string, fromAddress: string): string {
  const name = fromName.replace(/["']/g, '').replace(/\b(orders?|shipping|notifications?|customer service|no-?reply)\b/gi, '').replace(/[.,|-]+\s*$/, '').trim()
  if (name && !GENERIC_SENDER.test(name) && !name.includes('@')) return name.replace(/\.com$/i, '')
  const domain = (fromAddress.split('@')[1] ?? '').toLowerCase()
  const parts = domain.split('.').filter(p => !['com', 'net', 'org', 'co', 'uk', 'mail', 'email', 'e', 'em', 'shop', 'store'].includes(p))
  const core = parts[parts.length - 1] ?? domain
  return core ? core[0].toUpperCase() + core.slice(1) : 'Unknown'
}

export interface Explanation {
  passesPrefilter: boolean
  status: OrderStatus
  orderNumber: string | null
  orderNumberFrom?: 'subject' | 'body'
  retailer: string
  result: ParsedEmail | null
  /** Plain-English reason for the verdict. */
  reason: string
}

/** Runs the parser and says why it accepted or skipped the email. */
export function explainEmail(e: RawEmail): Explanation {
  const body = e.text.slice(0, 20000)
  const passesPrefilter = SUBJECT_HINT.test(e.subject)
  const status = detectStatus(e.subject, body)
  const found = findOrderNumber(e.subject, body)
  const retailer = extractRetailer(e.fromName, e.fromAddress)
  const base = { passesPrefilter, status, orderNumber: found?.orderNumber ?? null, orderNumberFrom: found?.where, retailer }

  if (!found) return { ...base, result: null, reason: 'No order number found in the subject or body.' }
  // A bare "#123456" with no status and no mention of an order is usually marketing.
  if (status === 'unknown' && !found.labeled && !/order/i.test(e.subject))
    return { ...base, result: null, reason: `Found "${found.orderNumber}" but no order wording or status, so it looked like marketing.` }

  const tracking = extractTracking(body)
  // A tracking number means a label exists: at least shipped, whatever the wording.
  const finalStatus: OrderStatus = status === 'unknown' || status === 'ordered' ? (tracking ? 'shipped' : 'ordered') : status
  const result: ParsedEmail = {
    orderNumber: found.orderNumber,
    retailer,
    status: finalStatus,
    date: e.date.toISOString(),
    subject: e.subject,
    messageId: e.messageId,
    total: extractTotal(body),
    items: extractItemCount(retailer, body),
    trackingNumber: tracking?.trackingNumber,
    carrier: tracking?.carrier
  }
  const reason = passesPrefilter
    ? `Recognised as ${result.status} for order ${result.orderNumber}.`
    : `Parses as ${result.status} for order ${result.orderNumber}, but sync skips it: the subject has none of the order keywords.`
  return { ...base, result, reason }
}

/** Returns null when the email isn't recognisably about an order. */
export function parseEmail(e: RawEmail): ParsedEmail | null {
  return explainEmail(e).result
}

// ---------- merging into orders ----------
const RANK: Record<OrderStatus, number> = {
  unknown: 0, ordered: 1, shipped: 2, out_for_delivery: 3, delivered: 4, returned: 5, cancelled: 6
}

function currentStatus(events: OrderEvent[]): OrderStatus {
  return events.reduce<OrderStatus>((best, ev) => (RANK[ev.status] > RANK[best] ? ev.status : best), 'unknown')
}

/** Merge parsed emails into the existing order map. Idempotent per messageId. */
export function mergeIntoOrders(existing: Order[], parsed: ParsedEmail[]): Order[] {
  const map = new Map(existing.map(o => [o.id, { ...o, accounts: [...(o.accounts ?? [])], events: [...o.events] }]))
  for (const p of parsed) {
    const id = `${p.retailer.toLowerCase()}:${p.orderNumber}`
    let o = map.get(id)
    if (!o) {
      o = { id, orderNumber: p.orderNumber, retailer: p.retailer, status: p.status, firstSeen: p.date, lastUpdate: p.date, accounts: [], events: [] }
      map.set(id, o)
    }
    if (p.account && !o.accounts.includes(p.account)) o.accounts.push(p.account)
    // Same email seen again (another inbox, or a re-check after a parser update):
    // keep one event, but take the newer parse so rule fixes reach existing orders.
    const dup = o.events.findIndex(ev => ev.messageId === p.messageId)
    if (dup >= 0) o.events[dup] = { ...o.events[dup], status: p.status, subject: p.subject }
    else o.events.push({ status: p.status, date: p.date, subject: p.subject, messageId: p.messageId, account: p.account })
    o.events.sort((a, b) => a.date.localeCompare(b.date))
    if (p.date < o.firstSeen) o.firstSeen = p.date
    if (p.date > o.lastUpdate) o.lastUpdate = p.date
    o.total ??= p.total
    // Shipping emails for a split order list only part of it: keep the largest count seen.
    if (p.items) o.items = Math.max(o.items ?? 0, p.items)
    if (p.trackingNumber) { o.trackingNumber = p.trackingNumber; o.carrier = p.carrier }
    if (!o.manual) o.status = currentStatus(o.events)
  }
  return [...map.values()].sort((a, b) => b.lastUpdate.localeCompare(a.lastUpdate))
}

/** Drop everything that came only from one account. Orders seen in other accounts keep their other events. */
export function removeAccount(orders: Order[], accountId: string): Order[] {
  const out: Order[] = []
  for (const o of orders) {
    const events = o.events.filter(ev => ev.account !== accountId)
    if (!events.length) continue
    out.push({
      ...o,
      events,
      accounts: (o.accounts ?? []).filter(a => a !== accountId),
      firstSeen: events[0].date,
      lastUpdate: events[events.length - 1].date,
      status: o.manual ? o.status : currentStatus(events)
    })
  }
  return out
}

/**
 * Bulk status change. 'auto' clears the manual override and recomputes the
 * status from the order's emails again.
 */
export function setStatuses(orders: Order[], ids: string[], status: OrderStatus | 'auto'): Order[] {
  const want = new Set(ids)
  return orders.map(o => {
    if (!want.has(o.id)) return o
    return status === 'auto'
      ? { ...o, manual: false, status: currentStatus(o.events) }
      : { ...o, manual: true, status }
  })
}

/**
 * Re-clean saved order numbers (e.g. after a parser fix) and merge any orders
 * that now share an id. Keeps manual statuses. Returns the input array when
 * nothing changed.
 */
export function repairOrderNumbers(orders: Order[]): Order[] {
  if (!orders.some(o => cleanOrderNumber(o.orderNumber) !== o.orderNumber)) return orders
  const map = new Map<string, Order>()
  for (const o of orders) {
    const orderNumber = cleanOrderNumber(o.orderNumber)
    const id = `${o.retailer.toLowerCase()}:${orderNumber}`
    const prev = map.get(id)
    if (!prev) { map.set(id, { ...o, id, orderNumber, accounts: [...(o.accounts ?? [])], events: [...o.events] }); continue }
    for (const ev of o.events) if (!prev.events.some(e => e.messageId === ev.messageId)) prev.events.push(ev)
    prev.events.sort((a, b) => a.date.localeCompare(b.date))
    for (const a of o.accounts ?? []) if (!prev.accounts.includes(a)) prev.accounts.push(a)
    prev.firstSeen = prev.events[0].date
    prev.lastUpdate = prev.events[prev.events.length - 1].date
    prev.total ??= o.total
    if (o.items) prev.items = Math.max(prev.items ?? 0, o.items)
    if (!prev.trackingNumber && o.trackingNumber) { prev.trackingNumber = o.trackingNumber; prev.carrier = o.carrier }
    if (o.manual && !prev.manual) { prev.manual = true; prev.status = o.status }
    if (!prev.manual) prev.status = currentStatus(prev.events)
  }
  return [...map.values()].sort((a, b) => b.lastUpdate.localeCompare(a.lastUpdate))
}

/**
 * Drop UPS numbers saved by older parsers that fail the format/check-digit test
 * (random link IDs). The next sync re-reads the emails and fills in the real one.
 * Returns the input array when nothing changed.
 */
export function repairTracking(orders: Order[]): Order[] {
  if (!orders.some(o => o.carrier === 'UPS' && o.trackingNumber && !isValidUps(o.trackingNumber))) return orders
  return orders.map(o => (o.carrier === 'UPS' && o.trackingNumber && !isValidUps(o.trackingNumber)
    ? { ...o, trackingNumber: undefined, carrier: undefined }
    : o))
}
