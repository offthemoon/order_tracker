import { contextBridge, ipcRenderer } from 'electron'
import type { Api, SyncProgress } from '../shared/types'

const api: Api = {
  getAccounts: () => ipcRenderer.invoke('accounts:get'),
  saveAccount: a => ipcRenderer.invoke('accounts:save', a),
  deleteAccount: id => ipcRenderer.invoke('accounts:delete', id),
  testConnection: s => ipcRenderer.invoke('imap:test', s),
  sync: () => ipcRenderer.invoke('orders:sync'),
  getOrders: () => ipcRenderer.invoke('orders:get'),
  setOrderStatus: (id, status) => ipcRenderer.invoke('orders:setStatus', id, status),
  setOrderStatuses: (ids, status) => ipcRenderer.invoke('orders:setStatuses', ids, status),
  deleteOrder: id => ipcRenderer.invoke('orders:delete', id),
  deleteOrders: ids => ipcRenderer.invoke('orders:deleteMany', ids),
  clearOrders: () => ipcRenderer.invoke('orders:clear'),
  diagnose: term => ipcRenderer.invoke('diagnose', term),
  getStoreNotice: () => ipcRenderer.invoke('store:notice'),
  openDataFolder: () => ipcRenderer.invoke('store:openFolder'),
  addFolder: (id, folder) => ipcRenderer.invoke('accounts:addFolder', id, folder),
  onSyncProgress: cb => {
    const h = (_e: unknown, p: SyncProgress) => cb(p)
    ipcRenderer.on('sync:progress', h)
    return () => ipcRenderer.removeListener('sync:progress', h)
  }
}

contextBridge.exposeInMainWorld('api', api)
