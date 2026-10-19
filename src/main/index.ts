import { app, BrowserWindow, clipboard, ipcMain, shell } from 'electron'
import { join } from 'path'
import type { ImapAccount, OrderStatus } from '../shared/types'
import * as store from './store'
import { diagnose, syncAll, testConnection } from './imap'
import { removeAccount, setStatuses } from './parser'

// The app loads only local files, so Chromium's HTTP disk cache is pointless; turning it
// off also stops the "Failing CreateMapBlock / Failed to save user data" noise on Windows.
app.commandLine.appendSwitch('disable-http-cache')

// Only one copy may run: two copies share the same data folder and clash over it.
// Launching again just brings the open window to the front.
if (!app.requestSingleInstanceLock()) {
  app.quit()
  process.exit(0)
}
app.on('second-instance', () => {
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.focus()
})

// App icon for the window (Windows/Linux) and the Dock (macOS). Path works from out/main.
const ICON = join(__dirname, '../../resources/icon.png')

let win: BrowserWindow | null = null
let syncing = false

function createWindow(): void {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    title: 'Summit Order Tracking',
    backgroundColor: '#0f1115',
    icon: ICON,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
  if (process.env['ELECTRON_RENDERER_URL']) win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  else win.loadFile(join(__dirname, '../renderer/index.html'))
}

ipcMain.handle('accounts:get', () => store.getPublicAccounts())
ipcMain.handle('accounts:save', (_e, a: ImapAccount) => store.saveAccount(a))
ipcMain.handle('accounts:delete', async (_e, id: string) => {
  if (syncing) throw new Error('Wait for the sync to finish.')
  const accounts = await store.deleteAccount(id)
  const orders = removeAccount(await store.getOrders(), id)
  await store.setOrders(orders)
  return { accounts, orders }
})
ipcMain.handle('imap:test', async (_e, a: ImapAccount) => {
  // Blank password in the form means "use the saved one".
  const saved = a.id ? await store.getFullAccount(a.id) : null
  return testConnection({ ...a, password: a.password || saved?.password })
})
ipcMain.handle('orders:sync', async () => {
  if (syncing) return { scanned: 0, matched: 0, orders: 0, accounts: [], error: 'A sync is already running.' }
  syncing = true
  try {
    return await syncAll(p => win?.webContents.send('sync:progress', p))
  } finally {
    syncing = false
  }
})
ipcMain.handle('orders:get', () => store.getOrders())
ipcMain.handle('store:notice', () => store.takeNotice())
ipcMain.handle('store:openFolder', () => shell.openPath(store.dataFolder()))
ipcMain.handle('diagnose', (_e, term: string) => diagnose(term))
ipcMain.handle('accounts:addFolder', (_e, id: string, folder: string) => store.addFolder(id, folder))
ipcMain.handle('orders:setStatus', async (_e, id: string, status: OrderStatus) => {
  const orders = (await store.getOrders()).map(o => (o.id === id ? { ...o, status, manual: true } : o))
  await store.setOrders(orders)
  return orders
})
ipcMain.handle('orders:setStatuses', async (_e, ids: string[], status: OrderStatus | 'auto') => {
  const orders = setStatuses(await store.getOrders(), ids, status)
  await store.setOrders(orders)
  return orders
})
ipcMain.handle('orders:deleteMany', async (_e, ids: string[]) => {
  const drop = new Set(ids)
  const orders = (await store.getOrders()).filter(o => !drop.has(o.id))
  await store.setOrders(orders)
  return orders
})
ipcMain.handle('orders:delete', async (_e, id: string) => {
  const orders = (await store.getOrders()).filter(o => o.id !== id)
  await store.setOrders(orders)
  return orders
})
ipcMain.handle('clipboard:copyImage', async (_e, r: { x: number; y: number; width: number; height: number }) => {
  if (!win) throw new Error('No window.')
  if (![r?.x, r?.y, r?.width, r?.height].every(Number.isFinite) || r.width <= 0 || r.height <= 0) throw new Error('Bad area.')
  // The renderer measures in CSS pixels; capturePage wants window pixels, which differ when zoomed.
  const z = win.webContents.getZoomFactor()
  const image = await win.webContents.capturePage({
    x: Math.round(r.x * z), y: Math.round(r.y * z), width: Math.round(r.width * z), height: Math.round(r.height * z)
  })
  clipboard.writeImage(image)
})
ipcMain.handle('orders:clear', async () => {
  await store.clearAll()
  return []
})

app.whenReady().then(() => {
  // macOS ignores the window icon; without this the Dock shows the default Electron one.
  if (process.platform === 'darwin') app.dock?.setIcon(ICON)
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
