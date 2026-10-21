import { useEffect, useRef, useState } from 'react'
import type { Order } from '@shared/types'
import { parseMoney } from '../status'
import logo from '../assets/summit.svg'
import pokemonCenterImg from '../assets/stores/pokemon-center.png'

interface Props {
  /** Orders already narrowed by the dashboard's date range and account filter. */
  orders: Order[]
  rangeLabel: string
  onClose: () => void
}

// Colours for stores we know (tile, ring slice and dot); others get one by rank.
const STORE_COLORS: Record<string, string> = {
  'target': '#e5372b',
  'pokémon center': '#f5c518',
  'pokemon center': '#f5c518',
  'walmart': '#0071ce',
  'amazon': '#e88a00',
  'best buy': '#0046be'
}
const RANK_COLORS = ['#43b047', '#7c8cff', '#d65db1']
const OTHER_COLOR = '#2c3557'
// Pictures shown in place of the letter tile.
const STORE_IMAGES: Record<string, string> = {
  'pokémon center': pokemonCenterImg,
  'pokemon center': pokemonCenterImg
}

const fmtCompact = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 2 })

const fmtPct = (part: number, total: number) => {
  const p = (part / total) * 100
  if (p > 0 && p < 1) return '<1%'
  const r = Math.round(p)
  return r === p ? `${r}%` : `~${r}%`
}

interface StoreRow { name: string; n: number; unit: 'item' | 'order'; color: string }

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

  // Per store: items when its emails list quantities, otherwise orders. Biggest first.
  const byStore = new Map<string, { orders: number; items: number }>()
  for (const o of kept) {
    const s = byStore.get(o.retailer) ?? { orders: 0, items: 0 }
    s.orders++
    s.items += o.items ?? 0
    byStore.set(o.retailer, s)
  }
  const stores = [...byStore]
    .map(([name, s]) => ({ name, n: s.items > 0 ? s.items : s.orders, unit: (s.items > 0 ? 'item' : 'order') as StoreRow['unit'] }))
    .sort((a, b) => b.n - a.n || a.name.localeCompare(b.name))
  const totalUnits = stores.reduce((sum, s) => sum + s.n, 0)
  const allItems = stores.every(s => s.unit === 'item')
  let spare = 0
  const top: StoreRow[] = stores.slice(0, 3).map(s => ({ ...s, color: STORE_COLORS[s.name.toLowerCase()] ?? RANK_COLORS[spare++] }))
  const otherUnits = totalUnits - top.reduce((sum, s) => sum + s.n, 0)
  const slices = [...top.map(s => ({ n: s.n, color: s.color })), ...(otherUnits > 0 ? [{ n: otherUnits, color: OTHER_COLOR }] : [])]
  const range = rangeLabel.toUpperCase()

  return (
    <div className="overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className={`spend-card ${capturing ? 'capturing' : ''}`} role="dialog" aria-modal="true" aria-label="Spending summary" tabIndex={-1} ref={ref}>
        <Mountains />

        <span className="spend-actions">
          <button className="spend-copy" onClick={copyImage} disabled={copy === 'busy'}>
            {copy === 'done' ? 'Copied!' : copy === 'error' ? "Couldn't copy" : 'Copy image'}
          </button>
          <button className="x" aria-label="Close" onClick={onClose}>×</button>
        </span>

        <div className="spend-head">
          <img className="spend-logo" src={logo} alt="" />
          <div className="spend-head-text">
            <div className="spend-title">Summit Order Tracking</div>
            <div className="spend-sub">Total spent<span>·</span>Order breakdown<span>·</span>{range}</div>
          </div>
        </div>

        <div className="spend-body">
          <div className="spend-donut">
            <Donut slices={slices} />
            <div className="spend-donut-center">
              <div className="spend-center-label">Total spent<br />({range})</div>
              <div className="spend-value">{fmtCompact(spent)}</div>
              {unpriced > 0 && (
                <div className="spend-pill"><CartIcon /><span>{unpriced} order{unpriced === 1 ? '' : 's'} with<br />no price found</span></div>
              )}
            </div>
          </div>

          {top.length === 0 ? (
            <div className="spend-empty">No orders in this range.</div>
          ) : (
            <ul className="spend-rows">
              {top.map(s => {
                const img = STORE_IMAGES[s.name.toLowerCase()]
                return (
                  <li key={s.name}>
                    {img ? (
                      <span className="spend-tile has-img"><img src={img} alt="" /></span>
                    ) : (
                      <span className="spend-tile" style={{ background: s.color }}>{s.name.replace(/[^A-Za-z0-9]/g, '')[0]?.toUpperCase() ?? '?'}</span>
                    )}
                    <span className="spend-store">
                      <span className="spend-store-name" title={s.name}>{s.name}</span>
                      <span className="spend-store-n">{s.n.toLocaleString()}</span>
                      <span className="spend-store-unit">{s.unit}{s.n === 1 ? '' : 's'}</span>
                    </span>
                    <span className="spend-share">
                      <span className="spend-dot" style={{ background: s.color }} />
                      <span>
                        <span className="spend-pct">{fmtPct(s.n, totalUnits)}</span>
                        <span className="spend-pct-label">of total{allItems ? ' items' : ''}</span>
                      </span>
                    </span>
                  </li>
                )
              })}
            </ul>
          )}
        </div>

        <div className="spend-foot">
          <CalendarIcon />
          {kept.length} order{kept.length === 1 ? '' : 's'} · {new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
        </div>
      </div>
    </div>
  )
}

/** Ring split into slices, starting at 12 o'clock and going clockwise. */
function Donut({ slices }: { slices: { n: number; color: string }[] }) {
  const size = 260, stroke = 16, r = (size - stroke) / 2, c = 2 * Math.PI * r
  const total = slices.reduce((sum, s) => sum + s.n, 0)
  const gap = slices.length > 1 ? 4 : 0
  let start = 0
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={OTHER_COLOR} strokeWidth={stroke} opacity={total ? 0 : 1} />
      <g transform={`rotate(-90 ${size / 2} ${size / 2})`}>
        {total > 0 && slices.map((s, i) => {
          const len = (s.n / total) * c
          const el = (
            <circle key={i} cx={size / 2} cy={size / 2} r={r} fill="none" stroke={s.color} strokeWidth={stroke}
              strokeDasharray={`${Math.max(len - gap, 0.01)} ${c}`} strokeDashoffset={-start} />
          )
          start += len
          return el
        })}
      </g>
    </svg>
  )
}

/** Faint mountain range along the bottom of the card. */
function Mountains() {
  return (
    <svg className="spend-mountains" viewBox="0 0 900 220" preserveAspectRatio="none" aria-hidden="true">
      <path d="M0 150 L70 95 L130 130 L210 60 L290 125 L360 85 L440 140 L520 70 L600 120 L680 80 L760 135 L830 95 L900 120 L900 220 L0 220 Z" fill="#1a2550" opacity="0.35" />
      <path d="M0 185 L90 140 L170 175 L250 120 L340 170 L430 135 L520 180 L610 130 L700 175 L790 145 L900 170 L900 220 L0 220 Z" fill="#121a3a" opacity="0.6" />
    </svg>
  )
}

function CartIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="9" cy="20" r="1.5" /><circle cx="18" cy="20" r="1.5" />
      <path d="M2 3h3l2.7 12.4a2 2 0 0 0 2 1.6h7.7a2 2 0 0 0 2-1.5L21 8H6" />
    </svg>
  )
}

function CalendarIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="5" width="18" height="16" rx="2" /><path d="M3 10h18M8 3v4M16 3v4" />
    </svg>
  )
}
