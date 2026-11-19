import { lazy, Suspense, useEffect, useMemo, useState } from 'react'
import type { ChartData, ScriptableContext } from 'chart.js'
import { ArrowRight, ArrowUpRight, CalendarDays, CheckCircle2, Clock3, LifeBuoy, Package, Plus, Settings2, Target, Ticket as TicketIcon, Users } from 'lucide-react'
import { Link } from 'react-router-dom'
import api from '../../lib/api'
import { EmptyState, Skeleton } from '../../components/ui/Feedback'

const AdminDashboardChart = lazy(() => import('./AdminDashboardChart'))

type Profile = { id: number; name: string; email: string; role: string; department: string | null }
type Ticket = {
  id: number
  ticket_number: string
  subject: string
  priority: string
  status: string
  department: string
  assignee?: { name: string } | null
  customer: { name: string } | null
  created_at: string
}
type TicketPage = { results: Ticket[]; total: number; status_counts: Record<string, number> }
type Meeting = { id: number; ticket_number: string; ticket_id: number; starts_at: string; duration_minutes: number; jitsi_url: string }
type Lead = { id: number; contact_name: string; company: string; email: string; status: 'NEW' | 'QUALIFIED' | 'CONVERTED' | 'LOST' }
type LeadPage = { results: Lead[]; total: number; status_counts: LeadStatusCounts }
type LeadStatusCounts = Record<Lead['status'], number>
type Analytics = {
  total_users: number
  total_customers: number
  total_tickets: number
  open_tickets: number
  closed_tickets: number
  critical_tickets: number
  tickets_by_priority: Record<string, number>
  tickets_by_department: Record<string, number>
  meetings: { total: number; upcoming: number }
  tickets_this_month: number
  monthly_trends: { month: string; tickets: number }[]
  workload_by_department: { department: string; active_tickets: number }[]
}

const card = 'crm-surface p-5'

function statusTone(status: string) {
  if (['RESOLVED', 'CLOSED'].includes(status)) return 'crm-badge bg-emerald-50 text-emerald-700'
  if (['IN_PROGRESS', 'MEETING_SCHEDULED'].includes(status)) return 'crm-badge bg-violet-50 text-violet-700'
  if (status === 'ASSIGNED') return 'crm-badge bg-blue-50 text-blue-700'
  return 'crm-badge bg-amber-50 text-amber-700'
}

function priorityTone(priority: string) {
  if (priority === 'CRITICAL') return 'crm-badge bg-rose-50 text-rose-700'
  if (priority === 'HIGH') return 'crm-badge bg-orange-50 text-orange-700'
  if (priority === 'LOW') return 'crm-badge bg-slate-100 text-slate-600'
  return 'crm-badge bg-sky-50 text-sky-700'
}

function Metric({ icon: Icon, label, value, detail, tone, loading, to }: {
  icon: typeof TicketIcon
  label: string
  value: number | string
  detail: string
  tone: string
  loading: boolean
  to: string
}) {
  return <Link to={to} aria-label={`${label}: ${value}. ${detail}. Open ${label.toLowerCase()}`} className="group block rounded-xl focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700">
    <article className={`${card} crm-dashboard-metric-card h-full transition-[border-color,transform,box-shadow] duration-200 group-hover:-translate-y-0.5 group-hover:border-emerald-200 group-hover:shadow-md`}>
      <div className="flex items-start justify-between gap-3"><div><p className="text-xs font-medium text-slate-500">{label}</p>{loading ? <Skeleton className="mt-3 h-8 w-20" /> : <p className="mt-2 text-3xl font-semibold tracking-tight text-slate-900 tabular-nums">{value}</p>}</div><span className={`grid h-9 w-9 place-items-center rounded-lg ${tone}`}><Icon size={18} /></span></div>
      <p className="mt-3 truncate text-[11px] text-slate-500">{detail}</p>
    </article>
  </Link>
}

export default function Dashboard() {
  const [profile, setProfile] = useState<Profile | null>(null)
  const [analytics, setAnalytics] = useState<Analytics | null>(null)
  const [tickets, setTickets] = useState<TicketPage | null>(null)
  const [meetings, setMeetings] = useState<Meeting[]>([])
  const [leads, setLeads] = useState<LeadPage | null>(null)
  const [leadStatusCounts, setLeadStatusCounts] = useState<LeadStatusCounts | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [refreshVersion, setRefreshVersion] = useState(0)

  useEffect(() => {
    let active = true
    const controller = new AbortController()
    const { signal } = controller
    async function loadDashboard() {
      setLoading(true)
      setError('')
      try {
        const { data: me } = await api.get<Profile>('/auth/me', { signal })
        if (!active) return
        setProfile(me)
        const salesAccess = ['MAIN_ADMIN', 'SALES_MANAGER'].includes(me.role)
        const [ticketResponse, meetingResponse, leadResponse, analyticsResponse] = await Promise.allSettled([
          api.get<TicketPage>('/tickets?per_page=10&sort=created_at&direction=desc', { signal }),
          api.get<Meeting[]>('/meetings?upcoming=true', { signal }),
          salesAccess
            ? api.get<LeadPage>('/leads?per_page=10', { signal })
            : Promise.resolve(null),
          me.role === 'MAIN_ADMIN'
            ? api.get<Analytics>('/admin/dashboard', { signal })
            : Promise.resolve(null),
        ])
        if (!active) return
        const failedSections: string[] = []
        if (ticketResponse.status === 'fulfilled') {
          setTickets(ticketResponse.value.data)
        } else {
          console.error('Dashboard tickets could not be loaded.', ticketResponse.reason)
        }
        if (meetingResponse.status === 'fulfilled') {
          setMeetings(meetingResponse.value.data)
        } else {
          failedSections.push('meetings')
          console.error('Dashboard meetings could not be loaded.', meetingResponse.reason)
        }
        if (leadResponse.status === 'fulfilled') {
          setLeads(leadResponse.value?.data || null)
          setLeadStatusCounts(leadResponse.value?.data.status_counts || null)
        } else {
          failedSections.push('leads')
          console.error('Dashboard leads could not be loaded.', leadResponse.reason)
        }
        if (analyticsResponse.status === 'fulfilled') {
          setAnalytics(analyticsResponse.value?.data || null)
        } else {
          failedSections.push('analytics')
          console.error('Dashboard analytics could not be loaded.', analyticsResponse.reason)
        }
        setError(failedSections.length
          ? `Some workspace data could not be loaded (${failedSections.join(', ')}). Retry to load it.`
          : '')
      } catch (error) {
        if (active && !signal.aborted) {
          console.error('Could not load the CRM workspace profile.', error)
          setError('Your workspace profile could not be loaded. Check your connection and retry.')
        }
      } finally {
        if (active && !signal.aborted) setLoading(false)
      }
    }
    void loadDashboard()
    const refresh = () => setRefreshVersion((version) => version + 1)
    window.addEventListener('crm:refresh', refresh)
    return () => {
      active = false
      controller.abort()
      window.removeEventListener('crm:refresh', refresh)
    }
  }, [refreshVersion])

  const trendChart = useMemo<ChartData<'line'>>(() => ({
    labels: analytics?.monthly_trends.map((item) => item.month) || [],
    datasets: [{
      label: 'New tickets',
      data: analytics?.monthly_trends.map((item) => item.tickets) || [],
      borderColor: '#8f7046',
      borderWidth: 2.5,
      pointRadius: 2.5,
      pointHoverRadius: 5,
      pointBackgroundColor: '#fff',
      pointBorderColor: '#8f7046',
      pointBorderWidth: 2,
      backgroundColor: (context: ScriptableContext<'line'>) => {
        const { ctx, chartArea } = context.chart
        if (!chartArea) return 'rgba(143, 112, 70, .08)'
        const gradient = ctx.createLinearGradient(0, chartArea.top, 0, chartArea.bottom)
        gradient.addColorStop(0, 'rgba(143, 112, 70, .14)')
        gradient.addColorStop(1, 'rgba(143, 112, 70, .005)')
        return gradient
      },
      fill: true,
      tension: .35,
    }],
  }), [analytics])
  const priorityChart = useMemo<ChartData<'doughnut'>>(() => ({
    labels: Object.keys(analytics?.tickets_by_priority || {}),
    datasets: [{
      data: Object.values(analytics?.tickets_by_priority || {}),
      backgroundColor: ['#9a9488', '#8f7046', '#c9a974', '#a95548'],
      borderWidth: 0,
    }],
  }), [analytics])
  const workloadChart = useMemo<ChartData<'bar'>>(() => ({
    labels: analytics?.workload_by_department.map((row) => row.department) || [],
    datasets: [{
      label: 'Active tickets',
      data: analytics?.workload_by_department.map((row) => row.active_tickets) || [],
      backgroundColor: (context: ScriptableContext<'bar'>) => {
        const { ctx, chartArea } = context.chart
        if (!chartArea) return '#8f7046'
        const gradient = ctx.createLinearGradient(0, chartArea.bottom, 0, chartArea.top)
        gradient.addColorStop(0, 'rgba(201, 169, 116, .68)')
        gradient.addColorStop(1, 'rgba(96, 73, 47, .9)')
        return gradient
      },
      borderRadius: 6,
      maxBarThickness: 34,
    }],
  }), [analytics])

  const activeTicketCount = tickets
    ? Object.entries(tickets.status_counts).reduce(
        (total, [status, count]) => total + (['RESOLVED', 'CLOSED'].includes(status) ? 0 : count),
        0,
      )
    : 0
  const resolvedTicketCount = tickets
    ? (tickets.status_counts.RESOLVED || 0) + (tickets.status_counts.CLOSED || 0)
    : 0
  const upcomingMeetings = meetings.filter((meeting) => new Date(meeting.starts_at).getTime() >= Date.now()).slice(0, 4)
  const isAdmin = profile?.role === 'MAIN_ADMIN'
  const salesAccess = profile?.role === 'MAIN_ADMIN' || profile?.role === 'SALES_MANAGER'
  const today = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' }).format(new Date())
  const chartText = document.documentElement.classList.contains('dark') ? '#d3cfc3' : '#7d786f'
  const chartGrid = document.documentElement.classList.contains('dark') ? 'rgba(201, 193, 176, .13)' : 'rgba(125, 120, 111, .16)'
  const metrics = analytics
    ? [
        { icon: Users, label: 'Customer accounts', value: analytics.total_customers, detail: `${analytics.total_users} user accounts overall`, tone: 'bg-emerald-50 text-emerald-800', to: '/admin' },
        { icon: TicketIcon, label: 'Open tickets', value: analytics.open_tickets, detail: `${analytics.critical_tickets} critical and active`, tone: 'bg-rose-50 text-rose-700', to: '/tickets' },
        { icon: CheckCircle2, label: 'Closed tickets', value: analytics.closed_tickets, detail: `${analytics.total_tickets} tickets in total`, tone: 'bg-emerald-50 text-emerald-700', to: '/tickets?status=CLOSED' },
        { icon: CalendarDays, label: 'Upcoming meetings', value: analytics.meetings.upcoming, detail: `${analytics.tickets_this_month} tickets opened this month`, tone: 'bg-amber-50 text-amber-700', to: '/meetings' },
      ]
    : [
        { icon: TicketIcon, label: 'Tickets in your queue', value: tickets?.total ?? '—', detail: profile?.department ? `Assigned to ${profile.department}` : 'Tickets available to your role', tone: 'bg-emerald-50 text-emerald-800', to: '/tickets' },
        { icon: Clock3, label: 'Active tickets', value: loading || !tickets ? '—' : activeTicketCount, detail: 'Open across your entire visible queue', tone: 'bg-amber-50 text-amber-700', to: '/tickets' },
        { icon: CalendarDays, label: 'Upcoming meetings', value: loading || !tickets ? '—' : upcomingMeetings.length, detail: 'Meetings linked to accessible tickets', tone: 'bg-emerald-50 text-emerald-700', to: '/meetings' },
        { icon: CheckCircle2, label: 'Resolved or closed', value: loading || !tickets ? '—' : resolvedTicketCount, detail: 'Across your entire visible queue', tone: 'bg-slate-100 text-slate-700', to: '/tickets' },
      ]
  const recommendations: { icon: typeof TicketIcon; title: string; detail: string; to: string }[] = []
  if (analytics?.critical_tickets) {
    recommendations.push({
      icon: TicketIcon,
      title: 'Review critical support tickets',
      detail: `${analytics.critical_tickets} critical ${analytics.critical_tickets === 1 ? 'ticket needs' : 'tickets need'} attention.`,
      to: '/tickets?priority=CRITICAL',
    })
  } else if (analytics?.open_tickets) {
    recommendations.push({
      icon: TicketIcon,
      title: 'Review the open support queue',
      detail: `${analytics.open_tickets} ${analytics.open_tickets === 1 ? 'ticket is' : 'tickets are'} still open.`,
      to: '/tickets',
    })
  }
  if (salesAccess && leadStatusCounts?.NEW) {
    recommendations.push({
      icon: Target,
      title: 'Qualify new sales leads',
      detail: `${leadStatusCounts.NEW} ${leadStatusCounts.NEW === 1 ? 'lead is' : 'leads are'} waiting in the new stage.`,
      to: '/leads?status=NEW',
    })
  }
  if (upcomingMeetings.length) {
    recommendations.push({
      icon: CalendarDays,
      title: 'Prepare for your next meeting',
      detail: `Next meeting: ${new Date(upcomingMeetings[0].starts_at).toLocaleString()}.`,
      to: '/meetings',
    })
  }

  if (isAdmin) {
    const activeLeads = (leadStatusCounts?.NEW || 0) + (leadStatusCounts?.QUALIFIED || 0)
    const recentStatusCounts = [
      (tickets?.status_counts.RESOLVED || 0) + (tickets?.status_counts.CLOSED || 0),
      (tickets?.status_counts.IN_PROGRESS || 0) + (tickets?.status_counts.MEETING_SCHEDULED || 0),
      (tickets?.status_counts.NEW || 0) + (tickets?.status_counts.ASSIGNED || 0),
    ]
    const statusLabels = ['Resolved', 'In progress', 'New / assigned']
    const statusColors = ['#b28d5e', '#47785d', '#88828f']
    const statusChart: ChartData<'doughnut'> = {
      labels: statusLabels,
      datasets: [{
        data: recentStatusCounts,
        backgroundColor: statusColors,
        borderWidth: 0,
        hoverOffset: 5,
      }],
    }
    const adminMetrics = [
      { label: 'Open tickets', value: analytics?.open_tickets ?? '—', detail: 'Current ticket status', icon: TicketIcon, tone: 'ops-icon-forest', trend: 'up' },
      { label: 'Active leads', value: loading ? '—' : activeLeads, detail: `${leadStatusCounts?.NEW ?? 0} new in the pipeline`, icon: Users, tone: 'ops-icon-sand', trend: 'up' },
      { label: 'Meetings', value: loading ? '—' : upcomingMeetings.length, detail: 'Upcoming lead meetings', icon: CalendarDays, tone: 'ops-icon-sand', trend: 'up' },
      { label: 'Resolved tickets', value: analytics?.closed_tickets ?? '—', detail: `${analytics?.total_tickets ?? 0} tickets overall`, icon: CheckCircle2, tone: 'ops-icon-lilac', trend: 'up' },
    ]

    return <div className="ops-dashboard space-y-4 sm:space-y-5">
      <section className="ops-heading">
        <div>
          <p className="ops-eyebrow">Workspace</p>
          <h1>Good morning, {profile?.name.split(' ')[0] || 'Admin'} <span aria-hidden="true">👋</span></h1>
          <p className="ops-heading-subtitle">Here&apos;s what&apos;s happening in your workspace today.</p>
        </div>
        <blockquote className="ops-quote">
          “Success is not just about solving problems, but about creating better experiences.”
          <span aria-hidden="true" />
        </blockquote>
        <div className="ops-date-card">
          <span className="ops-date-icon"><CalendarDays size={19} /></span>
          <span><strong>{new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' }).format(new Date())}</strong><small>Operations overview</small></span>
          <ArrowRight size={15} className="ops-date-arrow" />
        </div>
      </section>

      {error && <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800"><span>{error}</span><button type="button" onClick={() => setRefreshVersion((version) => version + 1)} className="rounded-lg border border-rose-300 bg-white px-3 py-1.5 text-xs font-semibold text-rose-800 transition hover:bg-rose-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-700">Retry</button></div>}

      <section aria-label="Workspace summary" className="ops-metrics">
        {adminMetrics.map(({ label, value, detail, icon: Icon, tone, trend }) => <article key={label} className="ops-metric crm-dashboard-metric-card">
          <span className={`ops-metric-icon ${tone}`}><Icon size={19} /></span>
          <div className="ops-metric-copy">
            <p>{label}</p>
            <strong>{value}</strong>
            <small><ArrowUpRight size={13} />{detail}</small>
          </div>
          <svg className="ops-sparkline" viewBox="0 0 64 28" aria-hidden="true">
            <path d={trend === 'up' ? 'M2 21 C12 20 14 23 22 15 S35 18 42 10 53 14 62 4' : 'M2 5 C12 8 14 4 22 12 S35 9 42 17 53 12 62 23'} />
          </svg>
        </article>)}
      </section>

      <section className="ops-middle-grid">
        <article className="ops-card ops-ticket-overview">
          <div className="ops-card-header">
            <div><h2>Ticket overview</h2><p>Track support performance and resolution activity.</p></div>
            <Link to="/tickets" className="ops-period">All tickets <ArrowRight size={13} /></Link>
          </div>
          <div className="ops-chart-layout">
            <div className="ops-trend">
              <div className="ops-chart-legend"><span><i className="ops-legend-created" />Created tickets</span></div>
              {analytics?.monthly_trends.length
                ? <div className="ops-line-chart"><Suspense fallback={<div className="h-full" aria-label="Loading chart" />}><AdminDashboardChart type="line" data={trendChart} options={{
                    maintainAspectRatio: false,
                    scales: {
                      x: { ticks: { color: chartText, maxRotation: 0, autoSkip: true }, grid: { display: false }, border: { display: false } },
                      y: { beginAtZero: true, ticks: { color: chartText, precision: 0 }, grid: { color: chartGrid }, border: { display: false } },
                    },
                    plugins: { legend: { display: false }, tooltip: { backgroundColor: '#292820', padding: 10, cornerRadius: 9 } },
                  }} /></Suspense></div>
                : <p className="ops-chart-empty">{loading ? 'Loading ticket activity…' : 'No ticket history available yet.'}</p>}
            </div>
            <div className="ops-status-chart">
              <div className="ops-doughnut"><Suspense fallback={<div className="h-full" aria-label="Loading chart" />}><AdminDashboardChart type="doughnut" data={statusChart} options={{
                maintainAspectRatio: false,
                cutout: '73%',
                plugins: { legend: { display: false }, tooltip: { backgroundColor: '#292820', padding: 10, cornerRadius: 9 } },
              }} /></Suspense><div><strong>{tickets?.results.length ?? '—'}</strong><span>Recent tickets</span></div></div>
              <ul>{statusLabels.map((label, index) => <li key={label}>
                <span><i style={{ backgroundColor: statusColors[index] }} />{label}</span>
                <strong>{recentStatusCounts[index]}</strong>
              </li>)}</ul>
            </div>
          </div>
        </article>

        <aside className="ops-side-stack">
          <article className="ops-insight">
            <span className="ops-insight-label"><span aria-hidden="true">✦</span> Service insight</span>
            <h2>Ticket status overview</h2>
            <p>{analytics?.open_tickets ?? 0} tickets are currently open across support teams.</p>
            <Link to="/tickets">View ticket statuses <ArrowRight size={14} /></Link>
            <span className="ops-insight-decoration" aria-hidden="true">✦</span>
          </article>
          <article className="ops-card ops-quick-actions">
            <div className="ops-card-header"><h2>Quick actions</h2><span>Shortcuts</span></div>
            <nav aria-label="Quick actions">
              {[
                { to: '/tickets', label: 'View tickets', icon: TicketIcon },
                { to: '/leads?create=lead', label: 'Add lead', icon: Users },
                { to: '/meetings', label: 'Schedule meeting', icon: CalendarDays },
                { to: '/products', label: 'Manage products', icon: Package },
              ].map(({ to, label, icon: Icon }) => <Link key={label} to={to}><span><Icon size={16} /></span>{label}<ArrowRight size={13} /></Link>)}
            </nav>
          </article>
        </aside>
      </section>

      <section className="ops-bottom-grid">
        <article className="ops-card ops-recent-tickets">
          <div className="ops-card-header">
            <div><h2>Ticket statuses</h2><p>Current status for recently opened tickets.</p></div>
            <Link to="/tickets">View all <ArrowRight size={13} /></Link>
          </div>
          <div className="ops-table-wrap">
            <table>
              <thead><tr><th>Ticket</th><th>Status</th></tr></thead>
              <tbody>
                {loading ? Array.from({ length: 4 }, (_, index) => <tr key={index}><td colSpan={2}><span className="ops-table-loading" /></td></tr>)
                  : tickets?.results.length ? tickets.results.slice(0, 5).map((ticket) => <tr key={ticket.id}>
                    <td>{ticket.ticket_number}</td>
                    <td><span className={`ops-pill ${ticket.status.toLowerCase()}`}>{ticket.status.replaceAll('_', ' ').toLowerCase()}</span></td>
                  </tr>)
                  : <tr><td colSpan={2} className="ops-empty-row">No ticket statuses are available.</td></tr>}
              </tbody>
            </table>
          </div>
        </article>

        <aside className="ops-side-stack">
          <article className="ops-card ops-meetings">
            <div className="ops-card-header"><div><h2>Upcoming meetings</h2><p>Managed by assigned ticket teams</p></div></div>
            <div className="ops-meeting-empty">{loading ? 'Loading meeting totals…' : `${upcomingMeetings.length} upcoming meetings`}</div>
          </article>
          <article className="ops-tip">
            <span className="ops-tip-icon"><LifeBuoy size={18} /></span>
            <span><strong>Keep service on track</strong><small>Review ticket status changes across support teams.</small></span>
            <Link to="/tickets" aria-label="Explore tickets"><ArrowRight size={15} /></Link>
          </article>
        </aside>
      </section>
    </div>
  }

  return <div className="space-y-6">
    <section className="flex flex-wrap items-end justify-between gap-4 border-b border-slate-200 pb-5">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[.16em] text-emerald-700">{today} · {isAdmin ? 'Operations overview' : `${profile?.department || 'Team'} workspace`}</p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight text-slate-900 sm:text-[28px]">Good to see you, {profile?.name.split(' ')[0] || 'there'}</h1>
        <p className="mt-1.5 text-sm text-slate-500">{isAdmin ? 'A concise view of customer support and team operations.' : 'Your customer conversations and upcoming work, in one place.'}</p>
      </div>
      <div className="flex flex-wrap gap-2">
        {salesAccess && <Link to="/leads?create=lead" className="inline-flex items-center gap-2 rounded-lg bg-emerald-700 px-3.5 py-2.5 text-sm font-semibold text-white transition hover:bg-emerald-800"><Plus size={16} />Add lead</Link>}
        <Link to="/tickets" className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3.5 py-2.5 text-sm font-semibold text-slate-700 transition hover:border-emerald-300 hover:text-emerald-800"><LifeBuoy size={16} />{isAdmin ? 'Ticket workspace' : 'Open tickets'}</Link>
      </div>
    </section>
    {error && <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800"><span>{error}</span><button type="button" onClick={() => setRefreshVersion((version) => version + 1)} className="rounded-lg border border-rose-300 bg-white px-3 py-1.5 text-xs font-semibold text-rose-800 transition hover:bg-rose-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-700">Retry</button></div>}

    <section aria-label="Workspace summary" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {metrics.map((metric) => <Metric key={metric.label} {...metric} loading={loading} />)}
    </section>

    <section aria-labelledby="recommended-actions-title" className="crm-surface overflow-hidden">
      <div className="flex flex-wrap items-end justify-between gap-3 border-b border-slate-100 px-5 py-4 sm:px-6">
        <div><p className="text-[11px] font-semibold uppercase tracking-[.14em] text-emerald-700">Make progress</p><h2 id="recommended-actions-title" className="mt-1 text-base font-semibold text-slate-900">Recommended next actions</h2></div>
        <p className="text-xs text-slate-500">Based on records available to your role</p>
      </div>
      {loading ? <div className="grid gap-3 p-4 sm:grid-cols-2 xl:grid-cols-3" aria-label="Loading recommendations">{Array.from({ length: 2 }, (_, index) => <div key={index} className="flex items-center gap-3 rounded-xl border border-slate-100 p-3"><Skeleton className="h-9 w-9 rounded-lg" /><div className="flex-1 space-y-2"><Skeleton className="h-3 w-3/4" /><Skeleton className="h-3 w-1/2" /></div></div>)}</div>
        : recommendations.length ? <div className="grid gap-3 p-4 sm:grid-cols-2 xl:grid-cols-3">{recommendations.map(({ icon: Icon, title, detail, to }) => <Link key={title} to={to} className="group flex items-center gap-3 rounded-xl border border-slate-100 p-3 transition hover:border-emerald-200 hover:bg-emerald-50/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-emerald-50 text-emerald-800"><Icon size={17} /></span>
          <span className="min-w-0 flex-1"><span className="block text-sm font-semibold text-slate-800">{title}</span><span className="mt-1 block text-xs text-slate-500">{detail}</span></span>
          <ArrowRight size={15} className="shrink-0 text-slate-400 transition group-hover:translate-x-0.5 group-hover:text-emerald-800" />
        </Link>)}</div>
        : <p className="px-5 py-5 text-sm text-slate-500">There are no priority actions in the ticket, lead, and meeting records currently available to you.</p>}
    </section>

    <section className="grid gap-4 xl:grid-cols-[minmax(0,1.65fr)_minmax(280px,.8fr)]">
      {analytics
        ? <article className="crm-surface p-5 sm:p-6">
            <div className="mb-4 flex items-end justify-between gap-3">
              <div><p className="text-[11px] font-semibold uppercase tracking-[.14em] text-emerald-700">Service performance</p><h2 className="mt-1 text-base font-semibold text-slate-900">Incoming tickets · last 12 months</h2></div>
              <Link to="/tickets" className="text-xs font-semibold text-emerald-800 hover:text-emerald-900">Explore tickets <ArrowRight className="ml-1 inline" size={14} /></Link>
            </div>
            {analytics.monthly_trends.length
              ? <div className="h-64"><Suspense fallback={<div className="h-full" aria-label="Loading chart" />}><AdminDashboardChart type="line" data={trendChart} options={{ maintainAspectRatio: false, scales: { x: { ticks: { color: chartText }, grid: { display: false }, border: { display: false } }, y: { beginAtZero: true, ticks: { color: chartText, precision: 0 }, grid: { color: chartGrid }, border: { display: false } } }, plugins: { legend: { display: false }, tooltip: { backgroundColor: '#123d32', padding: 12, cornerRadius: 10 } } }} /></Suspense></div>
              : <p className="grid h-64 place-items-center text-sm text-slate-500">There is no ticket history in this period.</p>}
          </article>
        : <article className="crm-surface flex min-h-64 flex-col justify-center p-6">
            <div className="grid h-11 w-11 place-items-center rounded-xl bg-emerald-50 text-emerald-800"><TicketIcon size={20} /></div>
            <p className="mt-4 text-sm font-semibold text-slate-900">Your work, at a glance</p>
            <p className="mt-1 max-w-sm text-sm leading-6 text-slate-500">Ticket summaries are based on records your account is allowed to see. Open the queue to search and filter your tickets.</p>
            <Link to="/tickets" className="mt-4 inline-flex w-fit items-center gap-2 text-sm font-semibold text-emerald-800">Go to tickets <ArrowRight size={15} /></Link>
          </article>}
      {analytics
        ? <article className="crm-surface p-5 sm:p-6">
            <div className="mb-2"><p className="text-[11px] font-semibold uppercase tracking-[.14em] text-slate-500">Support overview</p><h2 className="mt-1 text-base font-semibold text-slate-900">Tickets by priority</h2></div>
            {Object.keys(analytics.tickets_by_priority).length
              ? <div className="mx-auto h-60 max-w-sm"><Suspense fallback={<div className="h-full" aria-label="Loading chart" />}><AdminDashboardChart type="doughnut" data={priorityChart} options={{ maintainAspectRatio: false, cutout: '72%', plugins: { legend: { position: 'bottom', labels: { color: chartText, usePointStyle: true, padding: 16 } }, tooltip: { backgroundColor: '#123d32', padding: 12, cornerRadius: 10 } } }} /></Suspense></div>
              : <p className="grid h-60 place-items-center text-sm text-slate-500">No tickets to break down yet.</p>}
            <Link to="/tickets" className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-800 hover:text-emerald-900">Open ticket queue <ArrowRight size={14} /></Link>
          </article>
        : <article className="crm-surface overflow-hidden">
            <div className="border-b border-slate-100 px-5 py-4"><p className="text-[11px] font-semibold uppercase tracking-[.14em] text-emerald-700">On your calendar</p><h2 className="mt-1 text-base font-semibold text-slate-900">Upcoming meetings</h2></div>
            {loading ? <div className="space-y-4 px-5 py-5" aria-label="Loading meetings">{Array.from({ length: 3 }, (_, index) => <div key={index} className="flex items-center gap-3"><Skeleton className="h-9 w-9 rounded-lg" /><div className="flex-1 space-y-2"><Skeleton className="h-3 w-1/2" /><Skeleton className="h-2.5 w-2/3" /></div></div>)}</div>
              : upcomingMeetings.length ? <div className="divide-y divide-slate-100">{upcomingMeetings.map((meeting) => <div key={meeting.id} className="flex items-center gap-3 px-5 py-4"><span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-emerald-50 text-emerald-700"><CalendarDays size={17} /></span><div className="min-w-0 flex-1"><p className="text-xs font-semibold text-slate-800">Ticket {meeting.ticket_number}</p><p className="mt-1 text-[10px] text-slate-500">{new Date(meeting.starts_at).toLocaleString()}</p></div><a href={meeting.jitsi_url} target="_blank" rel="noreferrer" aria-label={`Join meeting for ticket ${meeting.ticket_number}`} className="rounded-lg bg-emerald-700 px-2.5 py-2 text-[10px] font-semibold text-white hover:bg-emerald-800">Join</a></div>)}</div>
                : <EmptyState icon={CalendarDays} title="No meetings coming up" description="Ticket meetings will appear here when scheduled." />}
          </article>}
    </section>

    {leads && <section className="grid gap-4 xl:grid-cols-[minmax(0,1.4fr)_minmax(280px,.8fr)]">
      <article className="crm-surface overflow-hidden">
        <div className="flex flex-wrap items-end justify-between gap-3 border-b border-slate-100 px-5 py-4 sm:px-6"><div><p className="text-[11px] font-semibold uppercase tracking-[.14em] text-emerald-700">Pipeline intelligence</p><h2 className="mt-1 text-base font-semibold text-slate-900">Lead qualification</h2></div><Link to="/leads" className="text-xs font-semibold text-emerald-800 hover:text-emerald-900">Open pipeline <ArrowRight className="ml-1 inline" size={14} /></Link></div>
        <div className="grid gap-2 p-4 sm:grid-cols-4 sm:p-5">
          {([{ status: 'NEW', label: 'New', tone: 'bg-slate-100 text-slate-700' }, { status: 'QUALIFIED', label: 'Qualified', tone: 'bg-emerald-50 text-emerald-800' }, { status: 'CONVERTED', label: 'Converted', tone: 'bg-cyan-50 text-cyan-900' }, { status: 'LOST', label: 'Lost', tone: 'bg-rose-50 text-rose-800' }] as const).map(({ status, label, tone }) => {
            const count = leadStatusCounts?.[status] ?? 0
            return <Link key={status} to={`/leads?status=${status}`} className="group rounded-xl border border-slate-100 bg-white p-3 transition hover:-translate-y-0.5 hover:border-emerald-200 hover:shadow-sm"><span className={`inline-flex rounded-full px-2 py-1 text-[10px] font-semibold ${tone}`}>{label}</span><span className="mt-3 block text-2xl font-semibold tabular-nums text-slate-900">{count}</span><span className="mt-1 block text-[11px] text-slate-500">{label.toLowerCase()} leads</span></Link>
          })}
        </div>
      </article>
      <article className="crm-surface overflow-hidden">
        <div className="border-b border-slate-100 px-5 py-4"><p className="text-[11px] font-semibold uppercase tracking-[.14em] text-slate-500">Next in pipeline</p><h2 className="mt-1 text-base font-semibold text-slate-900">Recently added leads</h2></div>
        {leads.results.filter((lead) => ['NEW', 'QUALIFIED'].includes(lead.status)).slice(0, 4).map((lead) => <Link key={lead.id} to={`/leads?search=${encodeURIComponent(lead.email)}`} className="flex items-center gap-3 border-b border-slate-100 px-5 py-3 last:border-0 hover:bg-slate-50"><span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-emerald-50 text-emerald-800"><Target size={15} /></span><span className="min-w-0 flex-1"><span className="block truncate text-sm font-semibold text-slate-800">{lead.contact_name}</span><span className="block truncate text-xs text-slate-500">{lead.company || lead.email}</span></span><span className="text-[10px] font-semibold text-emerald-800">{lead.status === 'NEW' ? 'New' : 'Qualified'}</span></Link>)}
        {!leads.results.some((lead) => ['NEW', 'QUALIFIED'].includes(lead.status)) && <p className="px-5 py-7 text-center text-sm text-slate-500">No active leads right now.</p>}
      </article>
    </section>}

    {analytics && <section className="grid gap-4 xl:grid-cols-2">
    <article className="crm-surface p-5"><p className="text-[11px] font-semibold uppercase tracking-[.14em] text-slate-500">Team operations</p><h2 className="mb-3 mt-1 text-base font-semibold text-slate-900">Active tickets by department</h2><div className="h-56"><Suspense fallback={<div className="h-full" aria-label="Loading chart" />}><AdminDashboardChart type="bar" data={workloadChart} options={{ indexAxis: 'y', maintainAspectRatio: false, scales: { x: { beginAtZero: true, ticks: { color: chartText, precision: 0 }, grid: { color: chartGrid }, border: { display: false } }, y: { ticks: { color: chartText }, grid: { display: false }, border: { display: false } } }, plugins: { legend: { display: false }, tooltip: { backgroundColor: '#123d32', padding: 12, cornerRadius: 10 } } }} /></Suspense></div></article>
      <article className="crm-surface flex flex-col justify-center bg-[#123d32] p-6 text-white"><p className="text-[11px] font-semibold uppercase tracking-[.14em] text-[#bfe6d2]">Quick access</p><h2 className="mt-2 text-xl font-semibold">Keep the queue moving</h2><p className="mt-2 max-w-sm text-sm leading-6 text-white/75">Review ticket priorities and manage the team using the workspace’s live data.</p><div className="mt-5 flex flex-wrap gap-2"><Link to="/tickets?priority=CRITICAL" className="rounded-lg bg-white px-3 py-2 text-xs font-semibold text-[#123d32] hover:bg-[#f6f4ec]">Review tickets</Link><Link to="/admin" className="rounded-lg border border-white/20 px-3 py-2 text-xs font-semibold text-white hover:bg-white/10">Manage team</Link></div></article>
    </section>}

    <section className="grid gap-4 xl:grid-cols-[minmax(0,1.5fr)_minmax(280px,.8fr)]">
      <article className="crm-surface overflow-hidden p-0">
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4 sm:px-6"><div><p className="text-xs font-semibold uppercase tracking-wider text-emerald-700">Live work queue</p><h2 className="mt-1 text-base font-semibold text-slate-900">{isAdmin ? 'Recently opened tickets' : 'Tickets in your workspace'}</h2></div><Link to="/tickets" className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-800 hover:text-emerald-900">View queue <ArrowRight size={14} /></Link></div>
        {loading ? <div className="space-y-4 px-5 py-5" aria-label="Loading tickets">{Array.from({ length: 5 }, (_, index) => <div key={index} className="flex items-center gap-3"><Skeleton className="h-9 w-9 rounded-lg" /><div className="flex-1 space-y-2"><Skeleton className="h-3 w-2/3" /><Skeleton className="h-2.5 w-1/2" /></div><Skeleton className="h-5 w-16 rounded-full" /></div>)}</div>
          : tickets?.results.length ? <div className="divide-y divide-slate-100">{tickets.results.slice(0, 6).map((ticket) => <Link key={ticket.id} to={`/tickets?ticket=${ticket.id}`} className="flex flex-wrap items-center gap-3 px-5 py-4 transition hover:bg-slate-50 sm:px-6">
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-emerald-50 text-emerald-800"><TicketIcon size={17} /></span>
              <span className="min-w-0 flex-1"><span className="block truncate text-sm font-semibold text-slate-900">{ticket.subject}</span><span className="mt-1 block truncate text-[10px] text-slate-500">{ticket.ticket_number} · {ticket.customer?.name || 'Deleted account'} · {ticket.department}</span></span>
              <span className={`rounded-full px-2.5 py-1 text-[10px] font-semibold ${priorityTone(ticket.priority)}`}>{ticket.priority}</span><span className={`rounded-full px-2.5 py-1 text-[10px] font-semibold ${statusTone(ticket.status)}`}>{ticket.status.replaceAll('_', ' ')}</span>
            </Link>)}</div>
          : <EmptyState icon={Package} title="Nothing in the queue yet" description="New tickets routed to your workspace will appear here." />}
      </article>
      <aside className="crm-surface flex flex-col justify-between p-5">
        <div><p className="text-[11px] font-semibold uppercase tracking-[.14em] text-emerald-700">Workspace shortcuts</p><h2 className="mt-1 text-base font-semibold text-slate-900">What would you like to do?</h2><p className="mt-1 text-xs leading-5 text-slate-500">Jump straight to the tools available to your account.</p></div>
        <nav aria-label="Workspace shortcuts" className="mt-4 divide-y divide-slate-100">{[
          { to: '/tickets', label: 'Find a ticket', icon: TicketIcon },
          { to: '/products', label: 'Browse products', icon: Package },
          { to: '/meetings', label: 'View meetings', icon: CalendarDays },
          ...(salesAccess ? [{ to: '/leads', label: 'Manage sales leads', icon: Target }] : []),
          ...(isAdmin ? [{ to: '/admin', label: 'Manage the team', icon: Users }] : []),
          { to: '/settings', label: 'Workspace settings', icon: Settings2 },
        ].map(({ to, label, icon: Icon }) => <Link key={to} to={to} className="flex items-center gap-3 py-3 text-sm font-medium text-slate-700 transition hover:translate-x-0.5 hover:text-emerald-800"><span className="grid h-8 w-8 place-items-center rounded-lg bg-emerald-50 text-emerald-800"><Icon size={16} /></span>{label}<ArrowRight className="ml-auto text-slate-400" size={14} /></Link>)}</nav>
      </aside>
    </section>
  </div>
}
