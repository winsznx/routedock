import { ExternalLink } from 'lucide-react'
import { cn } from '@/lib/utils'

function truncateHash(hash: string): string {
  if (hash.length <= 14) return hash
  return `${hash.slice(0, 8)}...${hash.slice(-6)}`
}

interface TxHashLinkProps {
  hash: string
  network?: string
  className?: string
}

export function TxHashLink({ hash, network = 'testnet', className }: TxHashLinkProps) {
  const explorerBase =
    process.env.NEXT_PUBLIC_STELLAR_EXPERT_URL ?? `https://stellar.expert/explorer/${network}`

  return (
    <a
      href={`${explorerBase}/tx/${hash}`}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        'inline-flex items-center gap-1 font-mono text-xs text-[var(--mono)] hover:underline',
        className,
      )}
    >
      {truncateHash(hash)}
      <ExternalLink className="h-3 w-3 shrink-0" />
    </a>
  )
}
