import { FormEvent, useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Star } from 'lucide-react'
import api from '../../lib/api'

type Submission = {
  id: number
  title: string | null
  comment: string
  rating: number
  display_name: string
  status: 'pending' | 'approved' | 'rejected'
  created_at: string
}
type SubmissionPage = { results: Submission[]; page: number; per_page: number; total: number }

function statusStyle(status: Submission['status']) {
  if (status === 'approved') return 'bg-emerald-50 text-emerald-800'
  if (status === 'rejected') return 'bg-rose-50 text-rose-800'
  return 'bg-amber-50 text-amber-800'
}

export default function CustomerFeedbackPage() {
  const [rating, setRating] = useState(0)
  const [optInName, setOptInName] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [loading, setLoading] = useState(true)
  const [submissions, setSubmissions] = useState<Submission[]>([])
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')

  const loadSubmissions = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const { data } = await api.get<SubmissionPage>('/feedback/mine?page=1&per_page=20')
      setSubmissions(data.results)
    } catch {
      setError('Your feedback history could not be loaded. Please try again.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void loadSubmissions() }, [loadSubmissions])

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const formElement = event.currentTarget
    setError('')
    setMessage('')
    if (rating < 1 || rating > 5) {
      setError('Choose a star rating from 1 to 5.')
      return
    }
    const form = new FormData(formElement)
    setSubmitting(true)
    try {
      await api.post('/feedback', {
        rating,
        title: String(form.get('title') || ''),
        comment: String(form.get('comment') || ''),
        display_name: optInName ? String(form.get('display_name') || '') : null,
      })
      formElement.reset()
      setRating(0)
      setOptInName(false)
      setMessage('Thank you — your feedback has been submitted for review.')
      await loadSubmissions()
    } catch (submitError: unknown) {
      if (typeof submitError === 'object' && submitError !== null && 'response' in submitError) {
        const response = submitError.response
        if (typeof response === 'object' && response !== null && 'status' in response && response.status === 429) {
          setError('Too many submissions. Please wait before sharing more feedback.')
        } else if (typeof response === 'object' && response !== null && 'data' in response &&
          typeof response.data === 'object' && response.data !== null && 'error' in response.data &&
          typeof response.data.error === 'string') {
          setError(response.data.error)
        } else {
          setError('Feedback could not be submitted. Check your connection and try again.')
        }
      } else {
        setError('Feedback could not be submitted. Check your connection and try again.')
      }
    } finally {
      setSubmitting(false)
    }
  }

  return <div className="mx-auto max-w-4xl space-y-6">
    <header className="flex flex-wrap items-end justify-between gap-4">
      <div><p className="text-xs font-bold uppercase tracking-[.16em] text-emerald-700">Your voice matters</p><h1 className="mt-2 text-3xl font-bold tracking-tight text-slate-900">Share feedback</h1><p className="mt-2 max-w-xl text-sm leading-6 text-slate-600">Tell us about your experience. Reviews are private until approved for publication.</p></div>
      <Link to="/reviews" className="text-sm font-semibold text-emerald-800 hover:underline">Read customer reviews</Link>
    </header>

    {error && <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">{error}</div>}
    {message && <div role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">{message}</div>}

    <form onSubmit={(event) => void submit(event)} className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7">
      <h2 className="text-lg font-semibold text-slate-900">How was your experience?</h2>
      <fieldset className="mt-5">
        <legend className="text-sm font-medium text-slate-700">Rating <span className="text-rose-600">*</span></legend>
        <div role="radiogroup" aria-label="Rating from 1 to 5 stars" className="mt-2 flex gap-1">
          {[1, 2, 3, 4, 5].map((value) => <button
            key={value}
            type="button"
            role="radio"
            aria-checked={rating === value}
            aria-label={`${value} ${value === 1 ? 'star' : 'stars'}`}
            onClick={() => setRating(value)}
            className="rounded-md p-1 text-amber-500 focus-visible:outline-2 focus-visible:outline-emerald-700"
          ><Star size={30} fill={rating >= value ? 'currentColor' : 'none'} /></button>)}
        </div>
      </fieldset>
      <label className="mt-5 block"><span className="mb-2 block text-sm font-medium text-slate-700">Review title <span className="font-normal text-slate-400">(optional)</span></span><input name="title" maxLength={120} className="form-input" placeholder="A short summary" /></label>
      <label className="mt-5 block"><span className="mb-2 block text-sm font-medium text-slate-700">Your feedback <span className="text-rose-600">*</span></span><textarea name="comment" required minLength={1} maxLength={3000} rows={6} className="form-input resize-y" placeholder="What went well? What could we improve?" /><span className="mt-1 block text-xs text-slate-500">Up to 3,000 characters.</span></label>
      <div className="mt-5 rounded-xl bg-slate-50 p-4">
        <label className="flex items-start gap-3 text-sm text-slate-700"><input type="checkbox" checked={optInName} onChange={(event) => setOptInName(event.target.checked)} className="mt-0.5 h-4 w-4 accent-emerald-700" /><span>Show a display name if this review is approved. Otherwise, it will appear as “Anonymous customer”.</span></label>
        {optInName && <label className="mt-3 block"><span className="mb-2 block text-xs font-semibold text-slate-600">Public display name</span><input name="display_name" required maxLength={80} className="form-input" autoComplete="nickname" placeholder="Name shown with your review" /></label>}
      </div>
      <button disabled={submitting} className="mt-6 rounded-xl bg-emerald-700 px-5 py-3 text-sm font-semibold text-white transition hover:bg-emerald-800 disabled:cursor-wait disabled:opacity-60">{submitting ? 'Submitting…' : 'Submit feedback'}</button>
    </form>

    <section aria-labelledby="feedback-history-heading" className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7">
      <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 id="feedback-history-heading" className="text-lg font-semibold text-slate-900">Your submissions</h2><p className="mt-1 text-sm text-slate-500">Review statuses are visible only to you and the moderation team.</p></div><button type="button" onClick={() => void loadSubmissions()} className="text-sm font-semibold text-emerald-800 hover:underline">Refresh</button></div>
      {loading ? <p role="status" className="py-8 text-center text-sm text-slate-500">Loading your submissions…</p>
        : submissions.length ? <div className="mt-5 space-y-3">
          {submissions.map((submission) => <article key={submission.id} className="rounded-xl border border-slate-200 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2"><div className="flex items-center gap-2"><span aria-label={`${submission.rating} out of 5 stars`} className="text-sm text-amber-600">{'★'.repeat(submission.rating)}{'☆'.repeat(5 - submission.rating)}</span><span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold capitalize ${statusStyle(submission.status)}`}>{submission.status}</span></div><time className="text-xs text-slate-500">{new Date(submission.created_at).toLocaleDateString()}</time></div>
            {submission.title && <h3 className="mt-3 text-sm font-semibold text-slate-800">{submission.title}</h3>}<p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-slate-600">{submission.comment}</p>
          </article>)}
        </div>
        : <p className="mt-5 rounded-xl bg-slate-50 p-6 text-center text-sm text-slate-500">You have not submitted feedback yet.</p>}
    </section>
  </div>
}
