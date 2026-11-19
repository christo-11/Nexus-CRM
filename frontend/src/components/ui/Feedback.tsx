import type { LucideIcon } from 'lucide-react'

export function Skeleton({ className = '' }: { className?: string }) {
  return <div aria-hidden="true" className={`skeleton ${className}`} />
}

export function EmptyState({ icon: Icon, title, description }: {
  icon?: LucideIcon
  title: string
  description: string
}) {
  return (
    <div className="flex flex-col items-center justify-center px-5 py-10 text-center">
      {Icon && <span className="mb-3 grid h-9 w-9 place-items-center rounded-lg bg-slate-100 text-slate-500"><Icon size={17} /></span>}
      <p className="text-sm font-medium text-slate-800">{title}</p>
      <p className="mt-1 max-w-sm text-xs leading-5 text-slate-500">{description}</p>
    </div>
  )
}
