type BrandProps = {
  className?: string
  markClassName?: string
  wordmarkClassName?: string
}

export function BrandMark({ className = "", markClassName = "" }: BrandProps) {
  return (
    <span className={`nexus-mark ${markClassName} ${className}`} aria-hidden="true">
      <svg viewBox="0 0 40 40" fill="none">
        <path d="M10 29V11h4.7L26 24.5V11h4v18h-4.6L14 15.4V29h-4Z" fill="currentColor" />
        <circle cx="31.5" cy="29" r="2.5" fill="#D5B875" />
      </svg>
    </span>
  )
}

export default function Brand({ className = "", markClassName = "", wordmarkClassName = "" }: BrandProps) {
  return (
    <span className={`nexus-brand ${className}`}>
      <BrandMark markClassName={markClassName} />
      <span className={`nexus-wordmark ${wordmarkClassName}`}><span>NEXUS</span><span className="nexus-wordmark-accent">CRM</span></span>
    </span>
  )
}
