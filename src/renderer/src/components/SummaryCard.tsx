import { useEffect, useRef, useState } from 'react'
import type { Order } from '@shared/types'
import { parseMoney } from '../status'
import logo from '../assets/summit.svg'

interface Props {
  /** Orders already narrowed by the dashboard's date range and account filter. */
  orders: Order[]
  rangeLabel: string
  onClose: () => void
}

// Tile colours for stores we know; anything else gets a colour from its name.
const STORE_COLORS: Record<string, string> = {
  'target': '#cc0000',
  'pokémon center': '#d6334a',
  'pokemon center': '#d6334a',
  'walmart': '#0071ce',
  'amazon': '#e88a00',
  'best buy': '#0046be'
}
const storeColor = (name: string) => {
  const known = STORE_COLORS[name.toLowerCase()]
  if (known) return known
  let h = 0
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360
  return `hsl(${h} 55% 42%)`
}

const fmtCompact = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 2 })

/** Spending card for the current range, shown over the dashboard. */
export default function SummaryCard({ orders, rangeLabel, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const close = useRef(onClose)
  close.current = onClose
  const [copy, setCopy] = useState<'idle' | 'busy' | 'done' | 'error'>('idle')
  const [capturing, setCapturing] = useState(false)

  // Focus once on open; Escape closes.
  useEffect(() => {
    ref.current?.focus()
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close.current() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const copyImage = async () => {
    const card = ref.current
    if (!card || copy === 'busy') return
    setCopy('busy')
    // Hide the buttons and square the corners for the shot, and wait for that to paint.
    setCapturing(true)
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))
    try {
      const b = card.getBoundingClientRect()
      await window.api.copyImage({ x: b.x, y: b.y, width: b.width, height: b.height })
      setCopy('done')
    } catch {
      setCopy('error')
    } finally {
      setCapturing(false)
      setTimeout(() => setCopy('idle'), 1800)
    }
  }

  // Cancelled and returned orders weren't really spent.
  const kept = orders.filter(o => o.status !== 'cancelled' && o.status !== 'returned')
  const spent = kept.reduce((sum, o) => sum + (parseMoney(o.total) ?? 0), 0)
  const unpriced = kept.filter(o => parseMoney(o.total) === null).length

  // Top 3 stores by number of orders (ties alphabetical).
  const top = (() => {
    const m = new Map<string, { orders: number; items: number }>()
    for (const o of kept) {
      const s = m.get(o.retailer) ?? { orders: 0, items: 0 }
      s.orders++
      s.items += o.items ?? 0
      m.set(o.retailer, s)
    }
    return [...m].sort((a, b) => b[1].orders - a[1].orders || a[0].localeCompare(b[0])).slice(0, 3)
  })()

  return (
    <div className="overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className={`spend-card ${capturing ? 'capturing' : ''}`} role="dialog" aria-modal="true" aria-label="Spending summary" tabIndex={-1} ref={ref}>
        <div className="spend-top">
          <span className="spend-brand"><img className="logo" src={logo} alt="" /> Summit Order Tracking</span>
          <span className="spend-actions">
            <button className="spend-copy" onClick={copyImage} disabled={copy === 'busy'}>
              {copy === 'done' ? 'Copied!' : copy === 'error' ? "Couldn't copy" : 'Copy image'}
            </button>
            <button className="x" aria-label="Close" onClick={onClose}>×</button>
          </span>
        </div>

        <div className="spend-hero">
          <div className="spend-label">Total spent ({rangeLabel})</div>
          <div className="spend-value">{fmtCompact(spent)}</div>
          {unpriced > 0 && <div className="spend-note">{unpriced} order{unpriced === 1 ? '' : 's'} with no price found</div>}
        </div>

        {top.length === 0 ? (
          <div className="spend-empty">No orders in this range.</div>
        ) : (
          <ul className="spend-stores">
            {top.map(([store, s]) => {
              // Items when the store's emails list quantities, otherwise orders.
              const [n, unit] = s.items > 0 ? [s.items, 'item'] : [s.orders, 'order']
              return (
                <li key={store}>
                  <span className="spend-tile" style={{ background: storeColor(store) }}>{store.replace(/[^A-Za-z0-9]/g, '')[0]?.toUpperCase() ?? '?'}</span>
                  <span className="spend-store">
                    <span className="spend-store-name" title={store}>{store}</span>
                    <span className="spend-store-n">{n}</span>
                    <span className="spend-store-unit">{unit}{n === 1 ? '' : 's'}</span>
                  </span>
                </li>
              )
            })}
          </ul>
        )}

        <div className="spend-foot">{kept.length} order{kept.length === 1 ? '' : 's'} · {new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</div>
      </div>
    </div>
  )
}
