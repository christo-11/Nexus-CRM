import { ArrowRight, Sparkles } from 'lucide-react'

type Props = { title: string; section: string }

export default function WorkspacePage({ title, section }: Props) {
  return (
    <div className="mx-auto max-w-3xl py-10 text-center sm:py-16">
      <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-blue-50 text-blue-600"><Sparkles size={25} /></div>
      <p className="mt-6 text-xs font-semibold uppercase tracking-widest text-blue-600">{section}</p>
      <h1 className="mt-2 text-3xl font-bold tracking-tight text-slate-900">{title}</h1>
      <p className="mx-auto mt-3 max-w-lg text-sm leading-6 text-slate-500">This workspace is part of the application navigation. Connect the relevant API workflow to bring live records into this view.</p>
      <div className="panel-card mx-auto mt-8 max-w-xl p-6 text-left">
        <p className="text-sm font-semibold text-slate-800">Ready to extend</p>
        <p className="mt-2 text-xs leading-5 text-slate-500">The backend includes organization-scoped models and REST endpoints for customers, deals, and support tickets. This view is a starting point for the corresponding workflow.</p>
        <button className="mt-4 inline-flex items-center gap-2 text-xs font-semibold text-blue-600">Explore workspace <ArrowRight size={14} /></button>
      </div>
    </div>
  )
}
