import { Bell, CheckCheck } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import api from '../../lib/api'

type Notification = { id: string; title: string; body: string; link: string; read_at: string | null; created_at: string }
type NotificationResponse = { results: Notification[] }

export default function NotificationMenu() {
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<Notification[]>([])
  const [error, setError] = useState('')
  const navigate = useNavigate()
  const unread = items.filter((item) => !item.read_at).length

  async function load() {
    setError('')
    try {
      const { data } = await api.get<NotificationResponse>('/notifications/')
      setItems(data.results)
    } catch {
      setError('Notifications could not be loaded.')
    }
  }

  useEffect(() => { void load() }, [])

  async function markAllRead() {
    try {
      await api.post('/notifications/mark_all_read/')
      await load()
    } catch {
      setError('Notifications could not be marked as read.')
    }
  }

  async function openNotification(notification: Notification) {
    if (!notification.read_at) {
      try {
        await api.post(`/notifications/${notification.id}/mark_read/`)
        setItems((current) => current.map((item) => item.id === notification.id ? { ...item, read_at: new Date().toISOString() } : item))
      } catch {
        setError('This notification could not be marked as read.')
        return
      }
    }
    setOpen(false)
    if (notification.link) navigate(notification.link)
  }

  return <div className="relative">
    <button onClick={() => { setOpen((value) => !value); if (!open) void load() }} className="icon-button relative" aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`} aria-expanded={open}>
      <Bell size={19} />{unread > 0 && <span className="absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-rose-500 px-1 text-[9px] font-bold text-white">{unread > 9 ? '9+' : unread}</span>}
    </button>
    {open && <section className="absolute right-0 top-12 z-50 w-[min(360px,calc(100vw-2rem))] overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-xl">
      <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3"><div><h2 className="text-sm font-bold text-slate-900">Notifications</h2><p className="text-[10px] text-slate-400">{unread} unread</p></div><button onClick={() => void markAllRead()} disabled={!unread} className="flex items-center gap-1 text-[11px] font-semibold text-blue-600 disabled:text-slate-300"><CheckCheck size={14} /> Mark all read</button></div>
      {error && <p role="alert" className="px-4 py-3 text-xs text-rose-600">{error}</p>}
      <div className="max-h-80 overflow-y-auto">{items.length ? items.map((item) => <button key={item.id} onClick={() => void openNotification(item)} className={`block w-full border-b border-slate-50 px-4 py-3 text-left hover:bg-slate-50 ${!item.read_at ? 'bg-blue-50/40' : ''}`}><span className="flex items-center gap-2 text-xs font-semibold text-slate-800">{!item.read_at && <span className="h-1.5 w-1.5 rounded-full bg-blue-600" />}{item.title}</span><span className="mt-1 block text-[11px] leading-4 text-slate-500">{item.body}</span><span className="mt-1.5 block text-[10px] text-slate-400">{new Date(item.created_at).toLocaleString()}</span></button>) : !error && <p className="px-4 py-8 text-center text-xs text-slate-400">You’re all caught up.</p>}</div>
    </section>}
  </div>
}
