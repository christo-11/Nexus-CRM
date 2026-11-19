import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import {
  BarChart3, CalendarDays, Command, LayoutDashboard, Package, Plus, Search, Settings2, Ticket, Target, X,
  type LucideIcon,
} from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import api from '../../lib/api'

type TicketResult = {
  id: number
  ticket_number: string
  subject: string
  customer: { name: string } | null
}
type LeadResult = { id: number; contact_name: string; email: string; company: string }
type PaletteOption = { label: string; detail: string; to: string; icon: LucideIcon }
type SearchResult = PaletteOption & { key: string }

const baseCommands: PaletteOption[] = [
  { label: 'Overview', detail: 'Workspace dashboard', to: '/', icon: LayoutDashboard },
  { label: 'Tickets', detail: 'Customer support queue', to: '/tickets', icon: Ticket },
  { label: 'Products', detail: 'Product catalogue', to: '/products', icon: Package },
  { label: 'Meetings', detail: 'Ticket-linked meetings', to: '/meetings', icon: CalendarDays },
  { label: 'Settings', detail: 'Profile and email settings', to: '/settings', icon: Settings2 },
]

type Props = { role?: string }

export default function CommandPalette({ role }: Props) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [searching, setSearching] = useState(false)
  const [searchFailed, setSearchFailed] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const returnFocusRef = useRef<HTMLElement | null>(null)
  const navigate = useNavigate()
  const canSearchLeads = role === 'MAIN_ADMIN' || role === 'SALES_MANAGER'

  const commands = useMemo(() => {
    const available = [...baseCommands]
    if (canSearchLeads) {
      available.push({ label: 'Sales leads', detail: 'Manage the sales pipeline', to: '/leads', icon: Target })
      available.push({ label: 'Create a lead', detail: 'Open the new lead form', to: '/leads?create=lead', icon: Plus })
    }
    if (role === 'MAIN_ADMIN') available.push({ label: 'Admin & analytics', detail: 'Team access and reports', to: '/admin', icon: BarChart3 })
    return available
  }, [canSearchLeads, role])
  const matchingCommands = commands.filter((item) => `${item.label} ${item.detail}`.toLowerCase().includes(query.trim().toLowerCase()))
  const commandOptions = matchingCommands.map((item) => ({ ...item, key: `command:${item.to}` }))
  const options: SearchResult[] = [
    ...commandOptions,
    ...results,
  ]

  useEffect(() => {
    function onKeyDown(event: WindowEventMap['keydown']) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : triggerRef.current
        setOpen(true)
      } else if (event.key === 'Escape') {
        setOpen(false)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  useEffect(() => {
    if (!open) return
    inputRef.current?.focus()
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previousOverflow
      returnFocusRef.current?.focus()
    }
  }, [open])

  useEffect(() => {
    setActiveIndex(0)
  }, [query, results])

  useEffect(() => {
    if (!open) return
    const term = query.trim()
    if (term.length < 2) {
      setResults([])
      setSearchFailed(false)
      setSearching(false)
      return
    }

    let active = true
    setSearching(true)
    setSearchFailed(false)
    const timer = window.setTimeout(async () => {
      const [tickets, leads] = await Promise.all([
        role !== 'MAIN_ADMIN'
          ? api.get<{ results: TicketResult[] }>('/tickets', { params: { search: term, per_page: 5 } })
            .then(({ data }) => ({ data, failed: false }))
            .catch(() => ({ data: null, failed: true }))
          : Promise.resolve({ data: null, failed: false }),
        canSearchLeads
          ? api.get<{ results: LeadResult[] }>('/leads', { params: { search: term, per_page: 5 } })
            .then(({ data }) => ({ data, failed: false }))
            .catch(() => ({ data: null, failed: true }))
          : Promise.resolve({ data: null, failed: false }),
      ])
      if (!active) return

      const ticketResults: SearchResult[] = tickets.data?.results.map((ticket) => ({
        key: `ticket:${ticket.id}`,
        label: ticket.subject,
        detail: `${ticket.ticket_number} · ${ticket.customer?.name || 'Customer'}`,
        to: `/tickets?ticket=${ticket.id}`,
        icon: Ticket,
      })) || []
      const leadResults: SearchResult[] = leads.data?.results.map((lead) => ({
        key: `lead:${lead.id}`,
        label: lead.contact_name,
        detail: `${lead.company || lead.email} · Sales lead`,
        to: `/leads?search=${encodeURIComponent(term)}`,
        icon: Target,
      })) || []
      setResults([...ticketResults, ...leadResults])
      setSearchFailed(tickets.failed || leads.failed)
      setSearching(false)
    }, 220)

    return () => {
      active = false
      window.clearTimeout(timer)
    }
  }, [canSearchLeads, open, query, role])

  function choose(option: SearchResult) {
    navigate(option.to)
    returnFocusRef.current = triggerRef.current
    setOpen(false)
  }

  function trapDialogFocus(event: ReactKeyboardEvent<HTMLElement>) {
    if (event.key !== 'Tab') return
    const focusable = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('input, button:not([tabindex="-1"])'))
      .filter((element) => !element.hasAttribute('disabled'))
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (!first || !last) return
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  function renderOption(option: SearchResult, index: number) {
    const Icon = option.icon
    return <button
      type="button"
      role="option"
      tabIndex={-1}
      aria-selected={index === activeIndex}
      id={`palette-${option.key}`}
      key={option.key}
      onMouseEnter={() => setActiveIndex(index)}
      onClick={() => choose(option)}
      className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition ${index === activeIndex ? 'bg-blue-50 text-blue-950' : 'text-slate-700 hover:bg-slate-50'}`}
    >
      <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg ${index === activeIndex ? 'bg-white text-blue-700' : 'bg-slate-100 text-slate-500'}`}><Icon size={17} /></span>
      <span className="min-w-0 flex-1"><span className="block truncate text-sm font-semibold">{option.label}</span><span className="mt-0.5 block truncate text-xs text-slate-500">{option.detail}</span></span>
      {option.key.startsWith('command:') && <Command size={14} className="text-slate-300" />}
    </button>
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActiveIndex((index) => options.length ? (index + 1) % options.length : 0)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveIndex((index) => options.length ? (index - 1 + options.length) % options.length : 0)
    } else if (event.key === 'Enter' && options[activeIndex]) {
      event.preventDefault()
      choose(options[activeIndex])
    }
  }

  return <>
    <button
      ref={triggerRef}
      type="button"
      onClick={() => {
        returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : triggerRef.current
        setOpen(true)
      }}
      aria-label="Search tickets, leads, and CRM pages"
      className="crm-command-trigger group flex h-10 w-10 min-w-0 shrink items-center justify-center gap-2.5 rounded-xl border border-slate-200 bg-slate-50 px-0 text-left text-slate-500 transition hover:border-blue-200 hover:bg-white hover:text-slate-700 focus-visible:outline-2 focus-visible:outline-blue-500 sm:w-full sm:justify-start sm:px-3"
    >
      <Search size={16} className="shrink-0 text-slate-400 group-hover:text-blue-600" />
      <span className="hidden min-w-0 flex-1 truncate text-xs sm:block">Search tickets, leads, or pages…</span>
      <kbd className="hidden shrink-0 rounded-md border border-slate-200 bg-white px-1.5 py-0.5 text-[10px] text-slate-500 sm:inline">{navigator.platform.includes('Mac') ? '⌘' : 'Ctrl'} K</kbd>
    </button>
    {open && <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-slate-950/45 px-3 pt-[12vh] backdrop-blur-sm sm:px-6"
      onMouseDown={(event) => { if (event.target === event.currentTarget) setOpen(false) }}
    >
      <section role="dialog" aria-modal="true" aria-labelledby="command-palette-title" onKeyDown={trapDialogFocus} className="w-full max-w-xl overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl">
        <h2 id="command-palette-title" className="sr-only">Search CRM and navigate</h2>
        <div className="flex items-center gap-3 border-b border-slate-100 px-4">
          <Search size={18} className="shrink-0 text-blue-600" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search tickets, leads, or pages…"
            aria-label="Search CRM"
            aria-controls="command-palette-options"
            aria-activedescendant={options[activeIndex] ? `palette-${options[activeIndex].key}` : undefined}
            className="h-14 min-w-0 flex-1 bg-transparent text-sm text-slate-900 outline-none placeholder:text-slate-400"
          />
          <button type="button" onClick={() => setOpen(false)} aria-label="Close search" className="rounded-lg p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-700"><X size={17} /></button>
        </div>
        <div id="command-palette-options" role="listbox" aria-label="Search results and pages" className="max-h-[min(60vh,480px)] overflow-y-auto p-2">
          {matchingCommands.length > 0 && <p className="px-3 pb-1 pt-2 text-[10px] font-bold uppercase tracking-wider text-slate-400">{query.trim() ? 'Pages and actions' : 'Quick navigation'}</p>}
          {commandOptions.map((option, index) => renderOption(option, index))}
          {results.length > 0 && <>
            <p className="px-3 pb-1 pt-3 text-[10px] font-bold uppercase tracking-wider text-slate-400">Records</p>
            {results.map((option, index) => renderOption(option, commandOptions.length + index))}
          </>}
          {searching && <p role="status" className="px-3 py-3 text-xs text-slate-500">Searching records…</p>}
          {searchFailed && <p role="alert" className="px-3 py-3 text-xs text-rose-700">Some records could not be searched. Try again or open the relevant module.</p>}
          {!searching && query.trim().length >= 2 && !results.length && !searchFailed && <p className="px-3 py-4 text-center text-xs text-slate-500">No matching records. Try another name, ticket number, or company.</p>}
          {query.trim().length < 2 && <p className="px-3 py-3 text-[11px] text-slate-400">Type at least 2 characters to search records. Use ↑ ↓ to navigate and Enter to open.</p>}
        </div>
        <div className="flex items-center justify-between border-t border-slate-100 bg-slate-50/80 px-4 py-2.5 text-[10px] text-slate-400"><span>Search is limited to records available to your account.</span><span>Esc to close</span></div>
      </section>
    </div>}
  </>
}
