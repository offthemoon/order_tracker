import type { OrderStatus } from '@shared/types'

export const STATUS_META: Record<OrderStatus, { label: string; color: string }> = {
  ordered: { label: 'Ordered', color: '#7c8cff' },
  shipped: { label: 'Shipped', color: '#3fb6e8' },
  out_for_delivery: { label: 'Out for delivery', color: '#f0b429' },
  delivered: { label: 'Delivered', color: '#3ecf8e' },
  cancelled: { label: 'Cancelled', color: '#ef5b5b' },
  returned: { label: 'Returned', color: '#b07cf0' },
  unknown: { label: 'Unknown', color: '#8a8f98' }
}

export const STATUS_ORDER: OrderStatus[] = ['ordered', 'shipped', 'out_for_delivery', 'delivered', 'cancelled', 'returned']

export function trackingUrl(carrier?: string, n?: string): string | null {
  if (!n) return null
  switch (carrier) {
    case 'UPS': return `https://www.ups.com/track?tracknum=${n}`
    case 'USPS': return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${n}`
    case 'FedEx': return `https://www.fedex.com/fedextrack/?trknbr=${n}`
    case 'DHL': return `https://www.dhl.com/us-en/home/tracking.html?tracking-id=${n}`
    default: return `https://www.google.com/search?q=track+${n}`
  }
}

export const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })

export const daysAgo = (iso: string) => {
  const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000)
  return d <= 0 ? 'today' : d === 1 ? '1 day ago' : `${d} days ago`
}

/** "$1,234.56" -> 1234.56; undefined/garbage -> null */
export const parseMoney = (t?: string): number | null => {
  if (!t) return null
  const n = Number(t.replace(/[^0-9.]/g, ''))
  return Number.isFinite(n) && n > 0 ? n : null
}

export const fmtMoney = (n: number) =>
  n.toLocaleString(undefined, { style: 'currency', currency: 'USD' })
