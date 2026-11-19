import { useEffect, useRef, useState } from 'react'
import {
  BarChart3, Bell, CalendarDays, CheckCircle2, ChevronDown, LayoutDashboard, LogOut, Menu, Moon,
  MessageSquare, Package, PanelLeftClose, PanelLeftOpen, Plus, Settings2, Sun, Target, Ticket, X,
} from 'lucide-react'
import { io } from 'socket.io-client'
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import Brand, { BrandMark } from '../ui/Brand'
import api from '../../lib/api'
import { readToken, updateAuthTokens } from '../../lib/authStorage'
import { useAuthStore } from '../../stores/auth'
import CustomerPortalPage from '../../features/portal/CustomerPortalPage'
import CommandPalette from './CommandPalette'

type Profile = { id: number; name: string; email: string; role: string; department: string | null }
type Notice = { id: number; kind: string; title: string; body: string; link: string | null; read_at: string | null; created_at: string }

export default function AutomationLayout() {
  const logout = useAuthStore((state) => state.logout)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [notices, setNotices] = useState<Notice[]>([])
  const [showNotices, setShowNotices] = useState(false)
  const [showProfile, setShowProfile] = useState(false)
  const [showQuickCreate, setShowQuickCreate] = useState(false)
  const [darkMode, setDarkMode] = useState(() => localStorage.getItem('smart-crm.theme') !== 'light')
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => localStorage.getItem('smart-crm.sidebar-collapsed') === 'true')
  const processedMeetingEvents = useRef(new Set<number>())
  const navigate = useNavigate()
  const location = useLocation()

  useEffect(() => {
    let active = true
    api.get<Profile>('/auth/me').then(({ data }) => {
      if (active) setProfile(data)
    }).catch(() => {
      if (active) logout()
    })
    const refreshNotifications = () => {
      api.get<Notice[]>('/notifications').then(({ data }) => {
        if (active) setNotices(data)
      }).catch((error: unknown) => console.error('Could not load CRM notifications.', error))
    }
    refreshNotifications()
    const notificationTimer = window.setInterval(refreshNotifications, 60_000)
    const access = readToken('crm.access')
    if (access) {
      const apiOrigin = import.meta.env.VITE_API_BASE_URL
        ? new URL(import.meta.env.VITE_API_BASE_URL, window.location.origin).origin
        : window.location.origin
      const socket = io(import.meta.env.VITE_SOCKET_URL || apiOrigin, {
        path: '/socket.io',
        auth: { token: access },
        reconnection: false,
      })
      let refreshing = false
      socket.on('notification', (notice: Notice) => {
        if (active) setNotices((items) => [notice, ...items.filter((item) => item.id !== notice.id)].slice(0, 100))
      })
      for (const event of ['ticket_created', 'ticket_updated', 'ticket_comment', 'lead_updated']) {
        socket.on(event, () => window.dispatchEvent(new Event('crm:refresh')))
      }
      socket.on('meeting_scheduled', (meeting: { id?: number }) => {
        if (typeof meeting?.id !== 'number' || processedMeetingEvents.current.has(meeting.id)) return
        processedMeetingEvents.current.add(meeting.id)
        if (processedMeetingEvents.current.size > 1000) {
          const oldestId = processedMeetingEvents.current.values().next().value
          if (oldestId !== undefined) processedMeetingEvents.current.delete(oldestId)
        }
        window.dispatchEvent(new Event('crm:refresh'))
      })
      socket.on('disconnect', (reason) => {
        if (reason === 'io server disconnect') socket.connect()
      })
      socket.on('connect_error', async () => {
        if (refreshing) return
        const refresh = readToken('crm.refresh')
        if (!refresh) return
        refreshing = true
        try {
          const { data } = await api.post<{ access: string; refresh?: string }>('/auth/token/refresh/', { refresh })
          updateAuthTokens(data.access, data.refresh)
          socket.auth = { token: data.access }
          socket.connect()
        } catch (error) {
          console.error('Could not refresh the real-time notification connection.', error)
        } finally {
          refreshing = false
        }
      })
      return () => {
        active = false
        window.clearInterval(notificationTimer)
        socket.disconnect()
      }
    }
    return () => {
      active = false
      window.clearInterval(notificationTimer)
    }
  }, [logout])

  useEffect(() => {
    document.documentElement.classList.toggle('dark', darkMode)
    localStorage.setItem('smart-crm.theme', darkMode ? 'dark' : 'light')
  }, [darkMode])

  useEffect(() => {
    localStorage.setItem('smart-crm.sidebar-collapsed', String(sidebarCollapsed))
  }, [sidebarCollapsed])

  async function markRead(notice: Notice) {
    if (notice.read_at) return
    try {
      const { data } = await api.post<Notice>(`/notifications/${notice.id}/read`)
      setNotices((items) => items.map((item) => item.id === data.id ? data : item))
    } catch (error) {
      console.error('Could not mark CRM notification as read.', error)
    }
  }

  async function openNotice(notice: Notice) {
    await markRead(notice)
    setShowNotices(false)
    if (notice.link) {
      const target = notice.kind === 'LEAD_ASSIGNED' && notice.link === '/leads'
        ? '/leads?origin=customer'
        : notice.link
      navigate(target)
    }
  }

  function signOut() {
    logout()
    navigate('/login', { replace: true })
  }

  const admin = profile?.role === 'MAIN_ADMIN'
  const customer = profile?.role === 'CUSTOMER'
  const isAskAiPage = location.pathname === '/ask-ai' || location.pathname === '/ai-support'
  const navGroups = [
    {
      label: 'Workspace',
      items: [
        { to: '/', label: 'Overview', icon: LayoutDashboard },
        { to: '/tickets', label: 'Support tickets', icon: Ticket },
        { to: '/products', label: 'Products', icon: Package },
        { to: '/meetings', label: 'Meetings', icon: CalendarDays },
      ],
    },
    ...((admin || profile?.role === 'SALES_MANAGER') ? [{
      label: 'Sales',
      items: [{ to: '/leads', label: 'Leads & pipeline', icon: Target }],
    }] : []),
    ...(admin || profile?.role === 'SUPPORT' ? [{
      label: admin ? 'Approval' : 'Support',
      items: [{ to: '/lead-review', label: admin ? 'Lead approvals' : 'Lead verification', icon: CheckCircle2 }],
    }] : []),
    ...(admin ? [{
      label: 'Administration',
      items: [
        { to: '/admin', label: 'Team & analytics', icon: BarChart3 },
        { to: '/admin/feedback', label: 'Feedback moderation', icon: MessageSquare },
      ],
    }] : []),
    {
      label: 'Account',
      items: [{ to: '/settings', label: 'Settings', icon: Settings2 }],
    },
  ]
  const links = navGroups.flatMap((group) => group.items)
  const pageTitle = links.find((link) => link.to === location.pathname)?.label
    || (isAskAiPage ? 'Ask AI' : location.pathname.startsWith('/leads') ? 'Sales leads' : location.pathname === '/lead-review' ? 'Lead verification and approval' : 'Customer workspace')
  const canCreateLead = admin || profile?.role === 'SALES_MANAGER'
  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      {!customer && <>
        {mobileNavOpen && <button type="button" aria-label="Close navigation" onClick={() => setMobileNavOpen(false)} className="fixed inset-0 z-30 bg-slate-950/50 backdrop-blur-sm md:hidden" />}
        <aside className={`crm-sidebar fixed inset-y-0 left-0 z-40 flex w-[220px] flex-col border-r border-white/10 text-white transition-[width,transform] duration-200 md:translate-x-0 ${sidebarCollapsed ? 'md:w-[76px]' : 'md:w-[220px]'} ${mobileNavOpen ? 'translate-x-0' : '-translate-x-full'}`}>
          <div className={`flex h-[72px] shrink-0 items-center border-b border-white/[0.08] ${sidebarCollapsed ? 'justify-between px-5 md:justify-center md:px-2' : 'justify-between px-5'}`}>
            <NavLink to="/" aria-label="NEXUS CRM overview" onClick={() => setMobileNavOpen(false)} className={`flex min-w-0 items-center ${sidebarCollapsed ? 'gap-0 md:justify-center' : 'gap-3'}`}>
              <Brand className={sidebarCollapsed ? 'gap-0 md:gap-3' : ''} markClassName="h-9 w-9" wordmarkClassName={sidebarCollapsed ? 'md:hidden' : ''} />
            </NavLink>
            <button type="button" onClick={() => setMobileNavOpen(false)} aria-label="Close navigation" className="rounded-lg p-2 text-slate-400 hover:bg-white/10 hover:text-white md:hidden"><X size={18} /></button>
            <button type="button" onClick={() => setSidebarCollapsed((value) => !value)} aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'} aria-pressed={sidebarCollapsed} title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'} className="hidden shrink-0 rounded-lg p-2 text-slate-400 hover:bg-white/10 hover:text-white md:block">
              {sidebarCollapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}
            </button>
          </div>
          <nav aria-label="Main navigation" className="flex-1 overflow-y-auto px-3 py-4">
            {navGroups.map(({ label: groupLabel, items }) => <section key={groupLabel} className="mb-5 last:mb-0">
              <h2 className={`crm-nav-group-title mb-2 px-3 text-[10px] font-bold uppercase tracking-[.16em] text-slate-500 ${sidebarCollapsed ? 'md:sr-only' : ''}`}>{groupLabel}</h2>
              <div className="space-y-1">
                {items.map(({ to, label, icon: Icon }) => <NavLink
                  key={to}
                  to={to}
                  end={to === '/'}
                  onClick={() => setMobileNavOpen(false)}
                  title={sidebarCollapsed ? label : undefined}
                  aria-label={label}
                  className={({ isActive }) => `group relative flex min-h-10 items-center gap-3 rounded-xl px-3 text-[13px] font-medium transition-[color,background-color,box-shadow,transform] duration-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-300 ${sidebarCollapsed ? 'md:justify-center md:px-0' : ''} ${isActive ? 'bg-emerald-500/15 text-emerald-100 shadow-[inset_2px_0_0_#D5B875]' : 'text-slate-400 hover:translate-x-0.5 hover:bg-white/[0.06] hover:text-white'}`}
                >
                  {({ isActive }) => <><Icon size={18} className={`shrink-0 ${isActive ? 'text-emerald-200' : 'text-slate-500 group-hover:text-slate-300'}`} /><span className={sidebarCollapsed ? 'md:sr-only' : ''}>{label}</span></>}
                </NavLink>)}
              </div>
            </section>)}
          </nav>
          <div className={`shrink-0 border-t border-white/[0.08] p-4 ${sidebarCollapsed ? 'md:flex md:justify-center md:px-2' : ''}`}>
            <div className={`${sidebarCollapsed ? 'md:hidden' : ''} min-w-0`}>
              <p className="truncate text-sm font-semibold">{profile?.name || 'Loading profile…'}</p>
              <p className="mt-1 truncate text-[11px] text-slate-400">{profile?.role.replaceAll('_', ' ') || ''}{profile?.department ? ` · ${profile.department}` : ''}</p>
              <button onClick={signOut} className="mt-3 flex w-full items-center gap-2 rounded-lg px-2 py-2 text-xs font-medium text-slate-300 hover:bg-white/[0.06] hover:text-white"><LogOut size={15} />Sign out</button>
            </div>
            <button type="button" onClick={signOut} aria-label="Sign out" title="Sign out" className={`hidden rounded-lg p-2 text-slate-400 hover:bg-white/10 hover:text-white ${sidebarCollapsed ? 'md:block' : 'md:hidden'}`}><LogOut size={17} /></button>
          </div>
        </aside>
      </>}
      <div className={`crm-workspace-shell ${customer ? '' : sidebarCollapsed ? 'md:pl-[76px]' : 'md:pl-[220px]'}`}>
        <header className="crm-topbar sticky top-0 z-20 flex min-h-[68px] items-center justify-between gap-3 border-b border-slate-200/80 px-3 backdrop-blur-xl sm:px-6">
          <div className="flex min-w-0 items-center gap-2">
            {!customer && <button type="button" onClick={() => setMobileNavOpen(true)} aria-label="Open navigation" className="rounded-lg p-2 text-slate-600 hover:bg-slate-100 md:hidden"><Menu size={19} /></button>}
            <div className="min-w-0 py-3">
              <div className="mb-1 hidden min-w-0 max-w-full items-center gap-1.5 overflow-hidden whitespace-nowrap text-[10px] font-medium uppercase tracking-[.12em] text-slate-400 sm:flex">
                <span className="shrink-0">Workspace</span><span aria-hidden="true" className="shrink-0">/</span>                                <span aria-current="page" className="crm-page-breadcrumb min-w-0 truncate text-emerald-700">{customer && !isAskAiPage ? 'Customer portal' : pageTitle}</span>
              </div>
              <div className="flex min-w-0 items-center gap-2 font-semibold">
                <BrandMark markClassName="h-8 w-8 rounded-lg" />
                <span className="truncate text-sm">{customer && !isAskAiPage ? 'Customer portal' : pageTitle}</span>
              </div>
            </div>
          </div>
          {!customer && <div className="crm-topbar-search flex min-w-0 flex-1 justify-center px-1 sm:px-3"><CommandPalette role={profile?.role} /></div>}
          <div className="crm-topbar-actions flex items-center gap-2">
            {customer && <Link to="/feedback" className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-emerald-200 px-2.5 text-xs font-semibold text-emerald-800 transition hover:bg-emerald-50 sm:px-3"><MessageSquare size={14} />Feedback</Link>}
            {customer && <Link to={isAskAiPage ? '/' : '/ask-ai'} className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-emerald-200 px-2.5 text-xs font-semibold text-emerald-800 transition hover:bg-emerald-50 sm:px-3">{isAskAiPage ? 'Customer portal' : 'Ask AI'}</Link>}
            {canCreateLead && <div className="relative">
              <button type="button" onClick={() => setShowQuickCreate((open) => !open)} aria-label="Quick create" aria-expanded={showQuickCreate} className="crm-create-button inline-flex h-9 items-center gap-1.5 rounded-lg bg-emerald-700 px-2.5 text-xs font-semibold text-white transition hover:bg-emerald-800 sm:px-3">
                <Plus size={16} /><span className="hidden sm:inline">Create</span>
              </button>
              {showQuickCreate && <div className="absolute right-0 top-12 z-30 w-52 rounded-xl border border-slate-200 bg-white p-1.5 shadow-xl">
                <button type="button" onClick={() => { setShowQuickCreate(false); navigate('/leads?create=lead') }} className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left text-sm font-medium text-slate-700 hover:bg-emerald-50 hover:text-emerald-800">
                  <Target size={16} className="text-emerald-700" />Add a sales lead
                </button>
              </div>}
            </div>}
            <button onClick={() => setDarkMode((value) => !value)} aria-label={darkMode ? 'Switch to light mode' : 'Switch to dark mode'} className="grid h-9 w-9 shrink-0 place-items-center rounded-xl text-slate-600 hover:bg-slate-100">
              {darkMode ? <Sun size={18} /> : <Moon size={18} />}
            </button>
            <div className="relative">
              <button onClick={() => setShowNotices((open) => !open)} aria-label={`Notifications${notices.some((notice) => !notice.read_at) ? ', unread' : ''}`} aria-expanded={showNotices} className="relative grid h-9 w-9 shrink-0 place-items-center rounded-xl text-slate-600 hover:bg-slate-100">
                <Bell size={18} />
                {notices.some((notice) => !notice.read_at) && <span className="absolute right-2 top-2 h-2 w-2 rounded-full bg-rose-500" />}
              </button>
              {showNotices && <div className="absolute right-0 top-12 z-30 max-h-[70vh] w-[min(360px,90vw)] overflow-y-auto rounded-xl border border-slate-200 bg-white p-2 shadow-xl">
                <div className="px-3 py-2 text-sm font-semibold">Notifications</div>
                {notices.length ? notices.map((notice) => <button key={notice.id} onClick={() => void openNotice(notice)} className={`block w-full rounded-lg px-3 py-2 text-left ${notice.read_at ? 'text-slate-500' : 'bg-emerald-50 text-slate-800'}`}>
                  <span className="block text-xs font-semibold">{notice.title}</span><span className="mt-1 block text-xs">{notice.body}</span>
                </button>) : <p className="px-3 py-5 text-xs text-slate-500">No notifications yet.</p>}
              </div>}
            </div>
            <div className="relative">
              <button onClick={() => setShowProfile((open) => !open)} aria-label="Open profile menu" aria-expanded={showProfile} className="flex items-center gap-2 rounded-xl p-1.5 text-left hover:bg-slate-100">
                <span className="grid h-9 w-9 place-items-center rounded-full bg-emerald-100 text-xs font-bold text-emerald-800">{(profile?.name || profile?.email || '?').slice(0, 1).toUpperCase()}</span>
                <span className="hidden max-w-40 sm:block"><span className="block truncate text-xs font-semibold text-slate-800">{profile?.name || 'Your account'}</span><span className="block truncate text-[10px] text-slate-400">{profile?.email}</span></span>
                <ChevronDown size={14} className="hidden text-slate-400 sm:block" />
              </button>
              {showProfile && <div className="absolute right-0 top-12 z-30 w-56 rounded-xl border border-slate-200 bg-white p-2 shadow-xl">
                <div className="border-b border-slate-100 px-3 py-2"><p className="truncate text-sm font-semibold text-slate-800">{profile?.name || 'Your account'}</p><p className="truncate text-xs text-slate-500">{profile?.email}</p><p className="mt-1 text-[10px] font-medium uppercase tracking-wide text-emerald-700">{profile?.role.replaceAll('_', ' ')}</p></div>
                {!customer && <Link to="/settings" onClick={() => setShowProfile(false)} className="mt-1 block w-full rounded-lg px-3 py-2 text-left text-sm font-medium text-slate-600 hover:bg-slate-50">Account settings</Link>}
                <button onClick={signOut} className="mt-1 w-full rounded-lg px-3 py-2 text-left text-sm font-medium text-slate-600 hover:bg-slate-50">Sign out</button>
              </div>}
            </div>
          </div>
        </header>
        <main className={customer ? 'mx-auto max-w-[1440px] px-4 py-6 sm:px-7 sm:py-8' : 'mx-auto max-w-[1600px] p-4 sm:p-6 xl:px-8'}>
          {customer && profile && !isAskAiPage && location.pathname !== '/feedback'
            ? <CustomerPortalPage profile={profile} />
            : <Outlet context={profile} />}
        </main>
      </div>
    </div>
  )
}
