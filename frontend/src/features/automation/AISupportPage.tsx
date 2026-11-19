import { FormEvent, useEffect, useRef, useState } from 'react'
import { Bot, Check, Headphones, Send, Sparkles } from 'lucide-react'
import { useOutletContext } from 'react-router-dom'
import axios from 'axios'
import api from '../../lib/api'

type Profile = { id: number; name: string; email: string; role: string; department: string | null }
type ChatMessage = {
  role: 'user' | 'assistant'
  content: string
  sources?: { title: string; relevance: number }[]
  needs_human_support?: boolean
}
type ChatResponse = {
  answer: string
  sources: { title: string; relevance: number }[]
  needs_human_support: boolean
}
type AIHealthResponse = { status: 'available' | 'warming' | 'warmup_failed' | 'models_missing' | 'unavailable' }
type TicketResponse = { ticket: { ticket_number: string } }

const suggestedQuestions = [
  'How do I contact support?',
  'How do I follow up on a support request?',
  'What if the assistant cannot answer?',
]

export default function AISupportPage() {
  const profile = useOutletContext<Profile | null>()
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [escalating, setEscalating] = useState(false)
  const [error, setError] = useState('')
  const [availability, setAvailability] = useState<'checking' | 'warming' | 'available' | 'warmup_failed' | 'unavailable' | 'models_missing'>('checking')
  const [ticketNumber, setTicketNumber] = useState('')
  const endOfMessages = useRef<HTMLDivElement>(null)
  const canRequestHumanSupport = profile?.role === 'CUSTOMER' || profile?.role === 'MAIN_ADMIN'
  const lastAssistantMessage = [...messages].reverse().find((message) => message.role === 'assistant')

  useEffect(() => {
    let active = true
    let timer = 0
    const checkHealth = () => {
      api.get<AIHealthResponse>('/ai-support/health')
        .then(({ data }) => {
          if (!active) return
          setAvailability(data.status)
          if (data.status === 'warming') timer = window.setTimeout(checkHealth, 2000)
        })
        .catch((requestError: unknown) => {
          if (!active) return
          const status = axios.isAxiosError<AIHealthResponse>(requestError)
            ? requestError.response?.data?.status
            : undefined
          setAvailability(status === 'models_missing' ? status : 'unavailable')
        })
    }
    checkHealth()
    return () => {
      active = false
      window.clearTimeout(timer)
    }
  }, [])

  useEffect(() => {
    endOfMessages.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [messages, busy])

  async function sendMessage(prompt = draft) {
    const content = prompt.trim()
    if (!content || busy || availability === 'warming') return
    const priorMessages = messages.slice(-10).map(({ role, content: messageContent }) => ({
      role,
      content: messageContent,
    }))
    const userMessage: ChatMessage = { role: 'user', content }
    setMessages((current) => [...current, userMessage])
    setDraft('')
    setBusy(true)
    setError('')
    try {
      const { data } = await api.post<ChatResponse>('/ai-support/chat', {
        message: content,
        history: priorMessages,
      })
      const reply: ChatMessage = {
        role: 'assistant',
        content: data.answer,
        sources: data.sources,
        needs_human_support: data.needs_human_support,
      }
      setMessages((current) => [...current, reply])
      setAvailability('available')
    } catch (requestError: unknown) {
      const apiMessage = axios.isAxiosError<{ error?: string }>(requestError)
        ? requestError.response?.data?.error
        : null
      setAvailability('unavailable')
      setMessages((current) => [...current, {
        role: 'assistant',
        content: 'I cannot reach the local support assistant right now. Please contact human support.',
        sources: [],
        needs_human_support: true,
      }])
      setError(apiMessage || 'The support assistant is temporarily unavailable.')
    } finally {
      setBusy(false)
    }
  }

  function submitMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    void sendMessage()
  }

  async function requestHumanSupport() {
    if (escalating || ticketNumber || !canRequestHumanSupport) return
    setEscalating(true)
    setError('')
    const transcript = messages.slice(-8).map((message) =>
      `${message.role === 'user' ? 'Customer' : 'Assistant'}: ${message.content}`,
    ).join('\n\n').slice(-12000)
    try {
      const { data } = await api.post<TicketResponse>('/tickets', {
        issue_category: 'TECHNICAL_SUPPORT',
        subject: 'Support request from Ask AI',
        description: `The customer requested human support through Ask AI.\n\nConversation:\n${transcript || 'The assistant was unavailable before a conversation could be started.'}`,
      })
      setTicketNumber(data.ticket.ticket_number)
    } catch (requestError: unknown) {
      const apiMessage = axios.isAxiosError<{ error?: string }>(requestError)
        ? requestError.response?.data?.error
        : null
      setError(apiMessage || 'The support ticket could not be created. Please try again.')
    } finally {
      setEscalating(false)
    }
  }

  return <div className="mx-auto max-w-4xl space-y-5">
    <section className="crm-surface overflow-hidden">
      <div className="border-b border-slate-100 bg-gradient-to-r from-emerald-50 to-white p-5 sm:p-7">
        <div className="flex items-start gap-3">
          <span className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-emerald-700 text-white"><Bot size={22} /></span>
          <div>
            <p className="text-xs font-semibold uppercase tracking-[.14em] text-emerald-700">NEXUS CRM</p>
            <h1 className="mt-1 text-2xl font-semibold tracking-tight text-slate-900">Ask AI</h1>
            <p className="mt-1 text-sm text-slate-600">Ask about active products and approved support information. Account-specific questions are handled by our support team.</p>
          </div>
        </div>
        <p role="status" className={`mt-4 text-xs ${availability === 'unavailable' || availability === 'models_missing' ? 'text-amber-800' : 'text-slate-500'}`}>
          {availability === 'checking' ? 'Checking local assistant…' : availability === 'warming' ? 'Warming up the local models and indexing support information. This is a one-time delay after startup; replies will be faster afterward.' : availability === 'available' ? 'Local assistant is ready.' : availability === 'warmup_failed' ? 'Local models are reachable but could not be warmed. Try sending a question; first response may take longer.' : availability === 'models_missing' ? 'Ollama is running, but the configured models are missing. Pull the models on the API host.' : 'Ollama is not reachable. Start Ollama on the API host to enable AI answers.'}
        </p>
      </div>

      <div className="min-h-[300px] space-y-4 p-4 sm:p-6" aria-live="polite">
        {!messages.length && <div className="py-4">
          <p className="text-sm font-medium text-slate-800">How can I help?</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {suggestedQuestions.map((question) => <button
              key={question}
              type="button"
              disabled={busy || availability === 'warming'}
              onClick={() => { void sendMessage(question) }}
              className="rounded-full border border-slate-200 bg-white px-3 py-2 text-left text-xs font-medium text-slate-700 transition hover:border-emerald-300 hover:bg-emerald-50 disabled:opacity-50"
            ><Sparkles className="mr-1.5 inline" size={13} />{question}</button>)}
          </div>
        </div>}
        {messages.map((message, index) => <div key={`${index}-${message.role}`} className={`flex ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}>
          <div className={`max-w-[90%] rounded-2xl px-4 py-3 sm:max-w-[80%] ${message.role === 'user' ? 'bg-emerald-700 text-white' : 'border border-slate-200 bg-white text-slate-800'}`}>
            <p className="whitespace-pre-wrap text-sm leading-6">{message.content}</p>
            {message.sources && message.sources.length > 0 && <div className="mt-3 border-t border-slate-200/70 pt-2">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Sources</p>
              <ul className="mt-1 space-y-1">{message.sources.map((source, sourceIndex) => <li key={`${source.title}-${sourceIndex}`} className="text-xs text-slate-600">{source.title}</li>)}</ul>
            </div>}
          </div>
        </div>)}
        {busy && <div className="flex justify-start"><p className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-500">Searching support information…</p></div>}
        <div ref={endOfMessages} />
      </div>

      {error && <p role="alert" className="mx-4 mb-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 sm:mx-6">{error}</p>}
      {ticketNumber && <p role="status" className="mx-4 mb-4 rounded-xl border border-emerald-100 bg-emerald-50 p-4 text-sm font-medium text-emerald-900 sm:mx-6"><Check className="mr-1.5 inline" size={16} />Support ticket {ticketNumber} was created successfully.</p>}
      {lastAssistantMessage?.needs_human_support && canRequestHumanSupport && !ticketNumber && <div className="mx-4 mb-4 rounded-xl border border-emerald-100 bg-emerald-50 p-4 sm:mx-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-emerald-950">Would you like a support specialist to help?</p>
            <button type="button" disabled={escalating} onClick={() => void requestHumanSupport()} className="inline-flex items-center gap-2 rounded-lg bg-emerald-800 px-3.5 py-2.5 text-sm font-semibold text-white transition hover:bg-emerald-900 disabled:cursor-wait disabled:opacity-60">
              <Headphones size={16} />{escalating ? 'Creating ticket…' : 'Contact human support'}
            </button>
          </div>
      </div>}

      <form onSubmit={submitMessage} className="flex items-end gap-2 border-t border-slate-100 bg-slate-50/70 p-3 sm:p-4">
        <label htmlFor="ai-support-message" className="sr-only">Ask a support question</label>
        <textarea
          id="ai-support-message"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              event.currentTarget.form?.requestSubmit()
            }
          }}
          maxLength={2000}
          rows={2}
          placeholder="Type your support question…"
          className="form-input min-h-[48px] resize-y bg-white"
        />
        <button type="submit" disabled={busy || availability === 'warming' || !draft.trim()} aria-label="Send message" className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-emerald-700 text-white transition hover:bg-emerald-800 disabled:cursor-not-allowed disabled:opacity-50"><Send size={17} /></button>
      </form>
      <p className="px-4 pb-3 text-[10px] text-slate-400 sm:px-6">AI responses can be inaccurate. Verify important details with the support team.</p>
    </section>
  </div>
}
