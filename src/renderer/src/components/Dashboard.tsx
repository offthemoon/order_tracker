import { useMemo, useRef, useState } from 'react'
import { CLOSED_STATUSES, type Order, type OrderStatus, type PublicAccount } from '@shared/types'
import { STATUS_META, STATUS_ORDER, daysAgo, fmtDate, fmtMoney, parseMoney, trackingUrl } from '../status'

type Filter = 'all' | 'active' | OrderStatus
type Range = 'today' | 'week' | 'month' | 'all'

const RANGES: { id: Range; label: string; title: string }[] = [
  { id: 'today', label: 'Today', title: 'Ordered since midnight' },
  { id: 'week', label: 'This week', title: 'Ordered since Sunday' },
  { id: 'month', label: 'This month', title: 'Ordered since the 1st' },
  { id: 'all', label: 'All time', title: 'Every order' }
]

/** Local-time start of the range, or null for all time. */
function rangeStart(r: Range): number | null {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  if (r === 'today') return d.getTime()
  if (r === 'week') { d.setDate(d.getDate() - d.getDay()); return d.getTime() }
  if (r === 'month') { d.setDate(1); return d.getTime() }
  return null
}

const RANGE_KEY = 'order-tracker.range'
const loadRange = (): Range => {
  try {
    const v = localStorage.getItem(RANGE_KEY)
    return RANGES.some(r => r.id === v) ? (v as Range) : 'all'
  } catch { return 'all' }
}

// Order numbers are covered unless the user has chosen to show them.
const REVEAL_KEY = 'order-tracker.revealOrderNumbers'
const loadReveal = (): boolean => {
  try { return localStorage.getItem(REVEAL_KEY) === '1' } catch { return false }
}

/** Covers all but the last 2 characters: "912003456789" -> "••••89". */
const maskOrderNumber = (n: string) => (n.length > 2 ? '••••' + n.slice(-2) : '•'.repeat(n.length))

interface Props {
  orders: Order[]
  accounts: PublicAccount[]
  onSetStatus: (id: string, s: OrderStatus) => void
  onSetStatuses: (ids: string[], s: OrderStatus | 'auto') => Promise<void>
  onDelete: (id: string) => void
  onDeleteMany: (ids: string[]) => Promise<void>
}

const STALE_DAYS = 14

export default function Dashboard({ orders: allOrders, accounts, onSetStatus, onSetStatuses, onDelete, onDeleteMany }: Props) {
  const [filter, setFilter] = useState<Filter>('active')
  const [q, setQ] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [acct, setAcct] = useState<string>('all')
  const [range, setRangeState] = useState<Range>(loadRange)
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [bulkStatus, setBulkStatus] = useState<OrderStatus | 'auto' | ''>('')
  const [reveal, setRevealState] = useState<boolean>(loadReveal)
  const lastClicked = useRef<string | null>(null)

  const setReveal = (v: boolean) => {
    setRevealState(v)
    try { localStorage.setItem(REVEAL_KEY, v ? '1' : '0') } catch { /* storage unavailable: fine */ }
  }
  const num = (n: string) => (reveal ? n : maskOrderNumber(n))
  // Email subjects usually repeat the order number, so cover it there too.
  const subj = (s: string, n: string) => (reveal || !n ? s : s.split(n).join(maskOrderNumber(n)))

  const multi = accounts.length > 1
  const userOf = (id: string) => accounts.find(a => a.id === id)?.user ?? 'removed account'
  // Everything below (tiles, bar, table) respects the account filter.
  // Everything below (tiles, value, bar, table) respects the account and date filters.
  const inAccount = useMemo(
    () => (acct === 'all' ? allOrders : allOrders.filter(o => o.accounts?.includes(acct))),
    [allOrders, acct]
  )
  const orders = useMemo(() => {
    const since = rangeStart(range)
    return since === null ? inAccount : inAccount.filter(o => new Date(o.firstSeen).getTime() >= since)
  }, [inAccount, range])
  const hiddenByRange = inAccount.length - orders.length

  const counts = useMemo(() => {
    const c = Object.fromEntries(STATUS_ORDER.map(s => [s, 0])) as Record<OrderStatus, number>
    for (const o of orders) c[o.status] = (c[o.status] ?? 0) + 1
    return c
  }, [orders])
  const active = orders.filter(o => !CLOSED_STATUSES.includes(o.status))
  // Money still out: every order not delivered, cancelled or returned.
  const activeValue = active.reduce((sum, o) => sum + (parseMoney(o.total) ?? 0), 0)
  const unpriced = active.filter(o => parseMoney(o.total) === null).length
  const stale = active.filter(o => Date.now() - new Date(o.lastUpdate).getTime() > STALE_DAYS * 86_400_000)

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return orders.filter(o => {
      if (filter === 'active' && CLOSED_STATUSES.includes(o.status)) return false
      if (filter !== 'all' && filter !== 'active' && o.status !== filter) return false
      if (!needle) return true
      return [o.orderNumber, o.retailer, o.trackingNumber ?? ''].some(v => v.toLowerCase().includes(needle))
    })
  }, [orders, filter, q])

  // Bulk actions only ever touch rows you can currently see.
  const picked = shown.filter(o => checked.has(o.id))
  const allPicked = shown.length > 0 && picked.length === shown.length

  const toggle = (id: string, shift: boolean) => {
    // Work out the range now: React may run the setChecked updater later,
    // after lastClicked has already moved on.
    const on = !checked.has(id)
    const from = lastClicked.current ? shown.findIndex(o => o.id === lastClicked.current) : -1
    const to = shown.findIndex(o => o.id === id)
    // Shift-click selects/deselects the whole range since the last click.
    const ids = (shift && from >= 0 ? shown.slice(Math.min(from, to), Math.max(from, to) + 1) : [shown[to]]).map(o => o.id)
    lastClicked.current = id
    setChecked(prev => {
      const next = new Set(prev)
      for (const x of ids) on ? next.add(x) : next.delete(x)
      return next
    })
  }
  const toggleAll = () => setChecked(allPicked ? new Set() : new Set(shown.map(o => o.id)))
  const clearPicked = () => { setChecked(new Set()); setBulkStatus(''); lastClicked.current = null }

  const applyBulk = async () => {
    if (!bulkStatus || !picked.length) return
    await onSetStatuses(picked.map(o => o.id), bulkStatus)
    clearPicked()
  }
  const deleteBulk = async () => {
    if (!confirm(`Remove ${picked.length} order${picked.length === 1 ? '' : 's'}? They'll come back on a full rescan (Reset + Sync).`)) return
    await onDeleteMany(picked.map(o => o.id))
    if (selected && checked.has(selected)) setSelected(null)
    clearPicked()
  }
  const setRange = (r: Range) => {
    setRangeState(r); clearPicked()
    try { localStorage.setItem(RANGE_KEY, r) } catch { /* storage unavailable: fine */ }
  }
  // Changing what's visible drops the selection so nothing hidden gets edited by surprise.
  const changeFilter = (f: Filter) => { setFilter(f); clearPicked() }

  const sel = orders.find(o => o.id === selected) ?? null
  const total = orders.length || 1

  return (
    <div className="dash">
      <section className="kpis">
        <Kpi label="Total orders" value={orders.length} onClick={() => changeFilter('all')} active={filter === 'all'} />
        <Kpi label="Still active" value={active.length} accent="#e6e8ec" sub={stale.length ? `${stale.length} quiet ${STALE_DAYS}d+` : undefined} onClick={() => changeFilter('active')} active={filter === 'active'} />
        <Kpi wide label="Active value" value={fmtMoney(activeValue)} accent="#3ecf8e"
          sub={unpriced ? `${unpriced} active order${unpriced === 1 ? '' : 's'} with no price found` : 'Not delivered, cancelled or returned'}
          subMuted={!unpriced} onClick={() => changeFilter('active')} active={false} />
        {STATUS_ORDER.map(s => (
          <Kpi key={s} label={STATUS_META[s].label} value={counts[s]} accent={STATUS_META[s].color} onClick={() => changeFilter(s)} active={filter === s} />
        ))}
      </section>

      {orders.length > 0 && (
        <div className="bar" title="Status breakdown">
          {STATUS_ORDER.filter(s => counts[s]).map(s => (
            <div key={s} style={{ width: `${(counts[s] / total) * 100}%`, background: STATUS_META[s].color }} title={`${STATUS_META[s].label}: ${counts[s]}`} />
          ))}
        </div>
      )}

      <div className="toolbar">
        <h2>{filter === 'all' ? 'All orders' : filter === 'active' ? 'Active orders' : STATUS_META[filter].label}<span className="muted"> · {shown.length}</span></h2>
        <div className="filters">
          <div className="seg" role="group" aria-label="Date range">
            {RANGES.map(r => (
              <button key={r.id} title={r.title} className={range === r.id ? 'on' : ''} onClick={() => setRange(r.id)}>{r.label}</button>
            ))}
          </div>
          {multi && (
            <select className="acct-select" value={acct} onChange={e => { setAcct(e.target.value); clearPicked() }}>
              <option value="all">All accounts</option>
              {accounts.map(a => <option key={a.id} value={a.id}>{a.user}</option>)}
            </select>
          )}
          <button className={`toggle ${reveal ? 'on' : ''}`} aria-pressed={reveal} title={reveal ? 'Cover order numbers' : 'Show full order numbers'} onClick={() => setReveal(!reveal)}>
            <EyeIcon open={reveal} />Order #s
          </button>
          <input className="search"placeholder="Search order #, store, tracking…" value={q} onChange={e => setQ(e.target.value)} />
        </div>
      </div>

      {hiddenByRange > 0 && (
        <div className="notice info row-between">
          <span>
            Showing orders placed <strong>{RANGES.find(r => r.id === range)!.label.toLowerCase()}</strong> ({RANGES.find(r => r.id === range)!.title.replace(/^Ordered /, '')}).
            {' '}{hiddenByRange} older order{hiddenByRange === 1 ? ' is' : 's are'} hidden.
          </span>
          <button className="ghost small-btn" onClick={() => setRange('all')}>Show all time</button>
        </div>
      )}

      {picked.length > 0 && (
        <div className="bulkbar">
          <strong>{picked.length} selected</strong>
          <span className="muted small">Shift-click to select a range</span>
          <div className="bulk-actions">
            <select value={bulkStatus} onChange={e => setBulkStatus(e.target.value as OrderStatus | 'auto' | '')}>
              <option value="">Set status to…</option>
              {STATUS_ORDER.map(s => <option key={s} value={s}>{STATUS_META[s].label}</option>)}
              <option value="auto">Auto (from emails)</option>
            </select>
            <button className="primary" onClick={applyBulk} disabled={!bulkStatus}>Apply</button>
            <button className="ghost danger-text" onClick={deleteBulk}>Remove</button>
            <button className="ghost" onClick={clearPicked}>Clear</button>
          </div>
        </div>
      )}

      <div className="main">
        <div className="tablewrap">
          {shown.length === 0 ? (
            <div className="empty">{orders.length ? 'No orders match this filter.' : allOrders.length ? `No orders placed ${RANGES.find(r => r.id === range)!.label.toLowerCase()}.` : 'No orders yet. Hit Sync to scan your inbox.'}</div>
          ) : (
            <table>
              <thead>
                <tr><th className="cb"><input type="checkbox" aria-label="Select all" checked={allPicked} ref={el => { if (el) el.indeterminate = picked.length > 0 && !allPicked }} onChange={toggleAll} /></th><th>Store</th><th>Order #</th><th>Status</th><th>Ordered</th><th>Last update</th><th>Total</th>{multi && <th>Account</th>}<th>Tracking</th></tr>
              </thead>
              <tbody>
                {shown.map(o => (
                  <tr key={o.id} className={`${o.id === selected ? 'sel' : ''} ${checked.has(o.id) ? 'picked' : ''}`} onClick={() => setSelected(o.id)}>
                    <td className="cb" onClick={e => { e.stopPropagation(); toggle(o.id, e.shiftKey) }}>
                      <input type="checkbox" aria-label={`Select ${num(o.orderNumber)}`} checked={checked.has(o.id)} readOnly />
                    </td>
                    <td className="store">{o.retailer}</td>
                    <td className="mono">{num(o.orderNumber)}</td>
                    <td><Badge s={o.status} manual={o.manual} /></td>
                    <td>{fmtDate(o.firstSeen)}</td>
                    <td className="muted">{daysAgo(o.lastUpdate)}</td>
                    <td>{o.total ?? '—'}</td>
                    {multi && <td className="muted small">{(o.accounts ?? []).map(userOf).join(', ')}</td>}
                    <td className="mono small">{o.trackingNumber ? `${o.carrier} · ${o.trackingNumber}` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {sel && (
          <aside className="detail">
            <div className="detail-head">
              <div>
                <div className="muted small">{sel.retailer}</div>
                <div className="mono big">{num(sel.orderNumber)}</div>
              </div>
              <button className="x" onClick={() => setSelected(null)}>×</button>
            </div>

            <label className="small muted">Status{sel.manual && ' (set manually)'}</label>
            <select value={sel.status} onChange={e => onSetStatus(sel.id, e.target.value as OrderStatus)}>
              {STATUS_ORDER.map(s => <option key={s} value={s}>{STATUS_META[s].label}</option>)}
            </select>
            {sel.manual && <button className="ghost small-btn" onClick={() => onSetStatuses([sel.id], 'auto')}>Reset to status from emails</button>}

            <dl>
              <dt>Ordered</dt><dd>{fmtDate(sel.firstSeen)}</dd>
              <dt>Total</dt><dd>{sel.total ?? '—'}</dd>
              {multi && <><dt>Found in</dt><dd>{(sel.accounts ?? []).map(userOf).join(', ')}</dd></>}
              <dt>Tracking</dt>
              <dd>{sel.trackingNumber ? <a href={trackingUrl(sel.carrier, sel.trackingNumber)!} target="_blank" rel="noreferrer">{sel.carrier} {sel.trackingNumber}</a> : '—'}</dd>
            </dl>

            <h3>Timeline</h3>
            <ol className="timeline">
              {[...sel.events].reverse().map(ev => (
                <li key={ev.messageId}>
                  <span className="dot" style={{ background: STATUS_META[ev.status].color }} />
                  <div>
                    <div><strong>{STATUS_META[ev.status].label}</strong> <span className="muted small">{fmtDate(ev.date)}</span></div>
                    <div className="muted small">{subj(ev.subject, sel.orderNumber)}</div>
                  </div>
                </li>
              ))}
            </ol>

            <button className="danger" onClick={() => { onDelete(sel.id); setSelected(null) }}>Remove order</button>
          </aside>
        )}
      </div>
    </div>
  )
}

function Kpi({ label, value, accent, sub, subMuted, wide, onClick, active }: {
  label: string; value: number | string; accent?: string; sub?: string; subMuted?: boolean; wide?: boolean; onClick: () => void; active: boolean
}) {
  return (
    <button className={`kpi ${active ? 'active' : ''} ${wide ? 'wide' : ''}`} onClick={onClick} style={{ borderTopColor: accent ?? 'var(--line)' }}>
      <span className="kpi-label">{label}</span>
      <span className="kpi-value">{value}</span>
      {sub && <span className={`kpi-sub ${subMuted ? 'muted' : ''}`}>{sub}</span>}
    </button>
  )
}

function EyeIcon({ open }: { open: boolean }) {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
      <circle cx="12" cy="12" r="3" />
      {!open && <line x1="3" y1="3" x2="21" y2="21" />}
    </svg>
  )
}

function Badge({ s, manual }: { s: OrderStatus; manual?: boolean }) {
  const m = STATUS_META[s]
  return (
    <span className="badge" style={{ color: m.color, background: `${m.color}1f` }}>
      {m.label}{manual ? ' •' : ''}
    </span>
  )
}
