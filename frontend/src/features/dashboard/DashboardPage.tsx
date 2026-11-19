import { useEffect, useState } from 'react'
import { ArrowRight, ArrowUpRight, BriefcaseBusiness, CircleDollarSign, Plus, Sparkles, TicketCheck, UsersRound } from 'lucide-react'
import { motion } from 'framer-motion'
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { Link } from 'react-router-dom'
import MetricCard from '../../components/ui/MetricCard'
import api from '../../lib/api'

type DashboardData = {
  kpis: {
    total_leads: number
    active_leads: number
    customers: number
    open_deals: number
    open_deal_value: number
    closed_deals: number
    revenue: number
    open_tickets: number
    risk_customers: number
    priority_tickets: number
  }
  revenue_by_month: { month: string; revenue: number }[]
  pipeline: { stage: string; value: number; count: number }[]
  activities: { id: string; actor_name: string; summary: string; object_type: string; created_at: string }[]
}

const currency = (value: number) => new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
}).format(value)

const stageColors: Record<string, string> = {
  QUALIFICATION: 'bg-blue-500',
  NEEDS_ANALYSIS: 'bg-cyan-500',
  PROPOSAL: 'bg-violet-500',
  NEGOTIATION: 'bg-amber-500',
}

export default function DashboardPage() {
  const [data, setData] = useState<DashboardData | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    api.get<DashboardData>('/dashboard/')
      .then((response) => setData(response.data))
      .catch(() => setError('Dashboard data could not be loaded. Please refresh to try again.'))
  }, [])
  const today = new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }).format(new Date())
  const kpis = data?.kpis
  const maxPipeline = Math.max(1, ...(data?.pipeline.map((stage) => stage.value) || [1]))

  return (
    <div className="space-y-6">
      <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div><div className="flex items-center gap-2 text-xs font-semibold uppercase text-blue-600"><span className="h-1.5 w-1.5 rounded-full bg-emerald-500" /> {today}</div><h1 className="mt-2 text-[27px] font-bold tracking-tight text-slate-900 sm:text-[31px]">Workspace overview</h1><p className="mt-1 text-sm text-slate-500">Live performance and activity for your organization.</p></div>
        <div className="flex gap-2"><Link to="/leads" className="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-4 py-2.5 text-[13px] font-semibold text-white shadow-lg shadow-blue-600/15 transition hover:bg-blue-700"><Plus size={17} /> Create lead</Link><Link to="/deals" className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-[13px] font-semibold text-slate-700 hover:bg-slate-50">View pipeline</Link></div>
      </motion.div>
      {error && <div role="alert" className="rounded-xl border border-rose-100 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</div>}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard label="Closed revenue" value={currency(kpis?.revenue || 0)} change={`${kpis?.closed_deals || 0} won`} icon={CircleDollarSign} tone="bg-blue-50 text-blue-600" comparison="closed deals" />
        <MetricCard label="Active leads" value={String(kpis?.active_leads || 0)} change={`${kpis?.total_leads || 0} total`} icon={UsersRound} tone="bg-violet-50 text-violet-600" comparison="in your workspace" />
        <MetricCard label="Open deals" value={String(kpis?.open_deals || 0)} change={currency(kpis?.open_deal_value || 0)} icon={BriefcaseBusiness} tone="bg-cyan-50 text-cyan-600" comparison="pipeline value" />
        <MetricCard label="Open tickets" value={String(kpis?.open_tickets || 0)} change={`${kpis?.priority_tickets || 0} urgent`} positive={(kpis?.priority_tickets || 0) === 0} icon={TicketCheck} tone="bg-amber-50 text-amber-600" comparison="need attention" />
      </div>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[1.65fr_1fr]">
        <section className="panel-card p-5 sm:p-6">
          <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-[15px] font-bold text-slate-900">Revenue overview</h2><p className="mt-1 text-xs text-slate-400">Won deals grouped by close month</p></div><span className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-600">Last 12 months</span></div>
          <div className="mt-5 flex items-baseline gap-2"><span className="text-[27px] font-bold tracking-tight text-slate-900">{currency(kpis?.revenue || 0)}</span><span className="inline-flex items-center text-xs font-semibold text-slate-500"><ArrowUpRight size={14} /> All-time</span></div>
          <div className="mt-4 h-[220px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={data?.revenue_by_month || []} margin={{ top: 8, right: 5, left: -20, bottom: 0 }}>
                <defs><linearGradient id="revenueFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#2563eb" stopOpacity={0.17} /><stop offset="95%" stopColor="#2563eb" stopOpacity={0} /></linearGradient></defs>
                <CartesianGrid stroke="#eef2f7" vertical={false} />
                <XAxis dataKey="month" axisLine={false} tickLine={false} tick={{ fill: '#94a3b8', fontSize: 11 }} dy={9} />
                <YAxis axisLine={false} tickLine={false} tick={{ fill: '#94a3b8', fontSize: 11 }} tickFormatter={(value: number) => `$${value}k`} />
                <Tooltip contentStyle={{ border: '1px solid #e2e8f0', borderRadius: 12, boxShadow: '0 8px 24px #0f172a12', fontSize: 12 }} formatter={(value) => [`${currency(Number(value) * 1000)}`, 'Revenue']} />
                <Area type="monotone" dataKey="revenue" stroke="#2563eb" strokeWidth={2.5} fill="url(#revenueFill)" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </section>
        <section className="panel-card p-5 sm:p-6">
          <div className="flex items-start justify-between"><div><h2 className="text-[15px] font-bold text-slate-900">Sales pipeline</h2><p className="mt-1 text-xs text-slate-400">Open opportunity distribution</p></div><Link aria-label="View sales pipeline" to="/deals" className="icon-button -mr-2 -mt-2"><ArrowRight size={17} /></Link></div>
          <div className="mt-6"><p className="text-[25px] font-bold tracking-tight text-slate-900">{currency(kpis?.open_deal_value || 0)}</p><p className="mt-1 text-[11px] text-slate-400">Total open pipeline value</p></div>
          <div className="mt-7 space-y-5">{data?.pipeline.map((item) => <div key={item.stage}><div className="mb-2 flex items-center justify-between text-xs"><span className="font-medium text-slate-600">{item.stage.replaceAll('_', ' ')}</span><span className="font-semibold text-slate-800">{currency(item.value)}</span></div><div className="flex items-center gap-3"><div className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-100"><div className={`h-full rounded-full ${stageColors[item.stage] || 'bg-blue-500'}`} style={{ width: `${Math.max(5, (item.value / maxPipeline) * 100)}%` }} /></div><span className="w-14 text-right text-[10px] text-slate-400">{item.count} deals</span></div></div>)}</div>
          {!data?.pipeline.length && <p className="mt-7 text-xs text-slate-400">Add an open deal to see your pipeline.</p>}
          <Link to="/deals" className="mt-7 flex w-full items-center justify-center gap-2 rounded-lg border border-slate-200 py-2.5 text-xs font-semibold text-slate-600 hover:bg-slate-50">Manage deals <ArrowRight size={14} /></Link>
        </section>
      </div>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[1.5fr_1fr]">
        <section className="panel-card">
          <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4 sm:px-6"><div><h2 className="text-[15px] font-bold text-slate-900">Recent activity</h2><p className="mt-1 text-xs text-slate-400">Latest changes across your workspace</p></div><Link to="/reports" className="text-xs font-semibold text-blue-600 hover:text-blue-700">Reports</Link></div>
          <div className="divide-y divide-slate-100">{data?.activities.map((item) => <div key={item.id} className="flex items-center gap-3 px-5 py-4 sm:px-6"><div className="avatar bg-blue-50 text-blue-700">{(item.actor_name || 'U').split(' ').map((part) => part[0]).slice(0, 2).join('')}</div><div className="min-w-0 flex-1"><p className="truncate text-xs text-slate-700">{item.summary}</p><p className="mt-1 text-[10px] text-slate-400">{new Date(item.created_at).toLocaleString()}</p></div><span className="hidden rounded-md bg-slate-50 px-2 py-1 text-[10px] font-medium text-slate-600 sm:inline-flex">{item.object_type}</span></div>)}</div>
          {data && !data.activities.length && <p className="px-6 py-8 text-center text-xs text-slate-400">Activity appears here as your team works.</p>}
        </section>
        <section className="overflow-hidden rounded-2xl bg-gradient-to-br from-[#172744] to-[#101a2e] p-5 text-white shadow-panel sm:p-6">
          <div className="flex items-center gap-2 text-xs font-semibold text-cyan-300"><Sparkles size={16} /> WORKSPACE HEALTH</div>
          <h2 className="mt-4 text-lg font-bold">Customer attention</h2>
          <p className="mt-2 text-xs leading-5 text-slate-300">Keep an eye on customers with low health scores and urgent requests that need a timely response.</p>
          <div className="mt-5 grid grid-cols-2 gap-3">
            <Link to="/customers" className="rounded-xl border border-white/10 bg-white/[0.06] p-3.5 hover:bg-white/[0.1]"><div className="text-[11px] text-slate-300">At-risk customers</div><div className="mt-1 text-xl font-bold">{kpis?.risk_customers ?? '—'}</div></Link>
            <Link to="/support" className="rounded-xl border border-white/10 bg-white/[0.06] p-3.5 hover:bg-white/[0.1]"><div className="text-[11px] text-slate-300">Urgent tickets</div><div className="mt-1 text-xl font-bold">{kpis?.priority_tickets ?? '—'}</div></Link>
          </div>
          <Link to="/reports" className="mt-5 flex items-center gap-2 text-xs font-semibold text-cyan-300 hover:text-cyan-200">Explore reports <ArrowRight size={14} /></Link>
        </section>
      </div>
      {data && <p className="text-center text-[10px] text-slate-400">Metrics reflect CRM records in your organization.</p>}
    </div>
  )
}
