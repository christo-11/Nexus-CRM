import type { LucideIcon } from 'lucide-react'
import { ArrowDownRight, ArrowUpRight } from 'lucide-react'

type Props = { label: string; value: string; change: string; positive?: boolean; icon: LucideIcon; tone: string; comparison: string }

export default function MetricCard({ label, value, change, positive = true, icon: Icon, tone, comparison }: Props) {
  return (
    <div className="panel-card p-5 sm:p-5">
      <div className="flex items-start justify-between">
        <div><p className="text-[12px] font-medium text-slate-500">{label}</p><p className="mt-3 text-[26px] font-semibold tracking-tight text-slate-900 tabular-nums sm:text-[29px]">{value}</p></div>
        <div className={`flex h-10 w-10 items-center justify-center rounded-lg ${tone}`}><Icon size={19} /></div>
      </div>
      <div className="mt-4 flex items-center gap-1.5 text-[11px]">
        <span className={`inline-flex items-center gap-0.5 rounded-md px-1.5 py-1 font-semibold ${positive ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-600'}`}>
          {positive ? <ArrowUpRight size={13} /> : <ArrowDownRight size={13} />}{change}
        </span>
        <span className="text-slate-400">{comparison}</span>
      </div>
    </div>
  )
}
