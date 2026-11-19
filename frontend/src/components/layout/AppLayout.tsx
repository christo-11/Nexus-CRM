import { ChevronDown, Command, LogOut, Menu, Search } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Outlet } from 'react-router-dom'
import Sidebar from './Sidebar'
import { useAuthStore } from '../../stores/auth'
import NotificationMenu from './NotificationMenu'
import api from '../../lib/api'
import CustomerPortalPage from '../../features/portal/CustomerPortalPage'

type Profile = { id: number; name: string; email: string; role: string; department: string | null }

export default function AppLayout() {
  const [menuOpen, setMenuOpen] = useState(false)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [profileLoaded, setProfileLoaded] = useState(false)
  const logout = useAuthStore((state) => state.logout)
  useEffect(() => {
    api.get<Profile>('/auth/me')
      .then(({ data }) => setProfile(data))
      .catch((error: unknown) => console.error('Could not load the CRM profile.', error))
      .finally(() => setProfileLoaded(true))
  }, [])
  const name = profile ? profile.name || profile.email : 'Loading profile'
  const initials = profile ? profile.name.slice(0, 2).toUpperCase() || profile.email.slice(0, 2).toUpperCase() : '…'
  if (!profileLoaded) return <div className="grid min-h-screen place-items-center text-sm text-slate-500">Loading your workspace…</div>
  if (profile?.role === 'CUSTOMER') return <CustomerPortalPage profile={profile} />
  return (
    <div className="min-h-screen bg-slate-50">
      <Sidebar open={menuOpen} onClose={() => setMenuOpen(false)} />
      <div className="lg:pl-[258px]">
        <header className="sticky top-0 z-20 flex h-[76px] items-center justify-between border-b border-slate-200/80 bg-white/90 px-4 backdrop-blur-xl sm:px-7">
          <div className="flex min-w-0 items-center gap-3">
            <button aria-label="Open navigation" className="icon-button lg:hidden" onClick={() => setMenuOpen(true)}><Menu size={20} /></button>
            <div className="hidden h-10 w-[min(32vw,360px)] items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 text-slate-400 md:flex">
              <Search size={17} />
              <span className="flex-1 text-sm">Search anything...</span>
              <kbd className="rounded border border-slate-200 bg-white px-1.5 py-0.5 text-[10px] text-slate-400">⌘ K</kbd>
            </div>
            <span className="truncate text-sm font-semibold text-slate-500 md:hidden">Workspace overview</span>
          </div>
          <div className="flex items-center gap-2 sm:gap-4">
            <button className="icon-button hidden sm:flex" aria-label="Search"><Command size={18} /></button>
            <NotificationMenu />
            <div className="mx-1 h-8 border-l border-slate-200" />
            <button className="flex items-center gap-2.5 rounded-xl p-1.5 text-left hover:bg-slate-50">
              <div className="avatar bg-blue-100 text-blue-700">{initials}</div>
              <span className="hidden sm:block"><span className="block text-sm font-semibold text-slate-800">{name}</span><span className="block text-xs capitalize text-slate-400">{profile?.role.replaceAll('_', ' ').toLowerCase() || 'CRM user'}</span></span>
              <ChevronDown size={15} className="hidden text-slate-400 sm:block" />
            </button>
            <button onClick={logout} className="icon-button" aria-label="Log out" title="Log out"><LogOut size={17} /></button>
          </div>
        </header>
        <main className="mx-auto max-w-[1600px] p-4 sm:p-7 xl:px-10"><Outlet /></main>
      </div>
      {menuOpen && <button aria-label="Close navigation" onClick={() => setMenuOpen(false)} className="fixed inset-0 z-30 bg-slate-950/40 lg:hidden" />}
    </div>
  )
}
