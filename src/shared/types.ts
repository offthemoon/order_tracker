// Shared between main, preload and renderer. No Node/DOM imports here.

export type OrderStatus =
  | 'ordered'          // confirmation received
  | 'shipped'          // label created / in transit
  | 'out_for_delivery'
  | 'delivered'
  | 'cancelled'
  | 'returned'         // return / refund issued
  | 'unknown'

/** Statuses that mean the order is finished. Everything else is "still alive". */
export const CLOSED_STATUSES: OrderStatus[] = ['delivered', 'cancelled', 'returned']

export interface ImapAccount {
  id: string          // empty string when creating a new account
  host: string
  port: number
  secure: boolean
  user: string
  /** Only sent renderer -> main on save. Never sent back to the renderer. */
  password?: string
  mailbox: string
  /** Additional folders to sync (e.g. Yahoo "Bulk"). */
  extraMailboxes?: string[]
  /** How many days back to scan on each sync. */
  lookbackDays: number
}

/** What the renderer sees: account minus the password. */
export interface PublicAccount extends Omit<ImapAccount, 'password'> {
  hasPassword: boolean
}

export interface OrderEvent {
  status: OrderStatus
  date: string        // ISO
  subject: string
  messageId: string
  account?: string    // ImapAccount.id it was found in
}

export interface Order {
  id: string          // `${retailer}:${orderNumber}`
  orderNumber: string
  retailer: string
  status: OrderStatus
  firstSeen: string   // ISO
  lastUpdate: string  // ISO
  total?: string
  trackingNumber?: string
  carrier?: string
  /** True when the user set the status by hand; sync won't overwrite it. */
  manual?: boolean
  /** Account ids this order was seen in. */
  accounts: string[]
  events: OrderEvent[]
}

export interface AccountSyncResult {
  accountId: string
  user: string
  scanned: number
  matched: number
  error?: string
}

export interface SyncResult {
  scanned: number
  matched: number
  orders: number
  accounts: AccountSyncResult[]
  error?: string
}

export interface SyncProgress {
  account: string     // user/email label
  index: number       // 1-based account number
  count: number       // total accounts
  done: number
  total: number
}

export type DiagnoseVerdict = 'tracked' | 'will_add' | 'wrong_folder' | 'skipped'

export interface DiagnoseHit {
  accountId: string
  account: string
  folder: string
  date: string
  from: string
  subject: string
  verdict: DiagnoseVerdict
  reason: string
  orderNumber: string | null
  status: OrderStatus
  /** First few hundred characters of the body, for the copyable report. */
  snippet: string
}

export interface DiagnoseResult {
  hits: DiagnoseHit[]
  /** Per-account problems (login failed etc.). */
  errors: string[]
  foldersSearched: number
  truncated: boolean
}

export interface Api {
  getAccounts(): Promise<PublicAccount[]>
  saveAccount(a: ImapAccount): Promise<PublicAccount[]>
  deleteAccount(id: string): Promise<{ accounts: PublicAccount[]; orders: Order[] }>
  testConnection(a: ImapAccount): Promise<{ ok: boolean; error?: string }>
  sync(): Promise<SyncResult>
  getOrders(): Promise<Order[]>
  setOrderStatus(id: string, status: OrderStatus): Promise<Order[]>
  /** 'auto' = drop manual override, go back to status from emails. */
  setOrderStatuses(ids: string[], status: OrderStatus | 'auto'): Promise<Order[]>
  deleteOrder(id: string): Promise<Order[]>
  deleteOrders(ids: string[]): Promise<Order[]>
  clearOrders(): Promise<Order[]>
  diagnose(term: string): Promise<DiagnoseResult>
  /** Set once if data had to be restored from a backup at startup. */
  getStoreNotice(): Promise<string | null>
  openDataFolder(): Promise<string>
  addFolder(accountId: string, folder: string): Promise<PublicAccount[]>
  onSyncProgress(cb: (p: SyncProgress) => void): () => void
}
