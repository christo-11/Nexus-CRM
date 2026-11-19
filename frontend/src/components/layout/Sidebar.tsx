import {
  BarChart3, CalendarDays, ChevronLeft, CircleHelp, LayoutDashboard,
  LifeBuoy, Settings2, UsersRound, X, Zap,
} from 'lucide-react'
import { NavLink } from 'react-router-dom'
import Brand from '../ui/Brand'

const navigation = [
  { label: 'Overview', to: '/', icon: LayoutDashboard },
  { label: 'Leads', to: '/leads', icon: Zap, badge: '12' },
  { label: 'Customers', to: '/customers', icon: UsersRound },
  { label: 'Deals & pipeline', to: '/deals', icon: BarChart3 },
  { label: 'Support inbox', to: '/support', icon: LifeBuoy, badge: '4' },
  { label: 'Meetings', to: '/meetings', icon: CalendarDays },
]

type Props = { open: boolean; onClose: () => void }

export default function Sidebar({ open, onClose }: Props) {
  return (
    <aside className={`fixed inset-y-0 left-0 z-40 flex w-[258px] flex-col bg-[#101a2e] text-white transition-transform duration-300 lg:translate-x-0 ${open ? 'translate-x-0' : '-translate-x-full'}`}>
      <div className="flex h-[76px] items-center justify-between border-b border-white/[0.07] px-5">
        <NavLink to="/" className="flex items-center gap-3" onClick={onClose}>
          <Brand markClassName="h-10 w-10" />
        </NavLink>
        <button onClick={onClose} aria-label="Close navigation" className="icon-button text-slate-400 hover:bg-white/10 lg:hidden"><X size={18} /></button>
      </div>
      <div className="px-4 pt-6">
        <button className="flex w-full items-center gap-3 rounded-xl border border-white/[0.08] bg-white/[0.045] p-3 text-left hover:bg-white/[0.08]">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-cyan-400/10 text-xs font-bold text-cyan-300">AC</div>
          <div className="min-w-0 flex-1"><div className="truncate text-[13px] font-semibold">Acme Corporation</div><div className="mt-0.5 text-[11px] text-slate-400">Enterprise plan</div></div>
          <ChevronLeft className="rotate-[-90deg] text-slate-500" size={15} />
        </button>
      </div>
      <nav className="flex-1 px-3 pt-7">
        <p className="mb-3 px-3 text-[10px] font-bold uppercase tracking-[0.15em] text-slate-500">Workspace</p>
        <div className="space-y-1">
          {navigation.map(({ label, to, icon: Icon, badge }) => (
            <NavLink key={to} to={to} end={to === '/'} onClick={onClose} className={({ isActive }) => `group flex items-center gap-3 rounded-xl px-3 py-[10px] text-[13px] font-medium transition-colors ${isActive ? 'bg-blue-500/15 text-blue-300' : 'text-slate-400 hover:bg-white/[0.05] hover:text-slate-100'}`}>
              {({ isActive }) => <><Icon size={18} className={isActive ? 'text-blue-400' : 'text-slate-500 group-hover:text-slate-300'} /><span className="flex-1">{label}</span>{badge && <span className={`rounded-md px-1.5 py-0.5 text-[10px] ${isActive ? 'bg-blue-500/20 text-blue-200' : 'bg-white/[0.07] text-slate-400'}`}>{badge}</span>}</>}
            </NavLink>
          ))}
        </div>
        <p className="mb-3 mt-8 px-3 text-[10px] font-bold uppercase tracking-[0.15em] text-slate-500">Manage</p>
        <NavLink to="/reports" onClick={onClose} className={({ isActive }) => `flex items-center gap-3 rounded-xl px-3 py-[10px] text-[13px] font-medium ${isActive ? 'bg-blue-500/15 text-blue-300' : 'text-slate-400 hover:bg-white/[0.05] hover:text-slate-100'}`}><BarChart3 size={18} /><span>Reports & insights</span></NavLink>
        <NavLink to="/settings" onClick={onClose} className={({ isActive }) => `mt-1 flex items-center gap-3 rounded-xl px-3 py-[10px] text-[13px] font-medium ${isActive ? 'bg-blue-500/15 text-blue-300' : 'text-slate-400 hover:bg-white/[0.05] hover:text-slate-100'}`}><Settings2 size={18} /><span>Settings</span></NavLink>
      </nav>
      <div className="mx-4 mb-4 rounded-2xl border border-blue-300/10 bg-gradient-to-br from-blue-500/[0.13] to-cyan-400/[0.06] p-4">
        <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-blue-200"><CircleHelp size={15} /> Need a hand?</div>
        <p className="mb-3 text-[11px] leading-relaxed text-slate-400">Explore the help center or reach out to our team.</p>
        <button className="w-full rounded-lg bg-white/[0.08] py-2 text-xs font-semibold text-slate-200 hover:bg-white/[0.12]">Visit help center</button>
      </div>
      <div className="flex items-center gap-3 border-t border-white/[0.07] px-5 py-4">
        <div className="avatar bg-gradient-to-br from-violet-400 to-blue-500 text-white">JD</div>
        <div className="min-w-0 flex-1"><div className="truncate text-xs font-semibold">Jordan Davis</div><div className="truncate text-[10px] text-slate-500">jordan@acme.com</div></div>
        <button aria-label="Open settings" onClick={onClose} className="text-slate-500 hover:text-white"><Settings2 size={16} /></button>
      </div>
    </aside>
  )
}
