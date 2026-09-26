'use client'

import { useState } from 'react'
import { Copy, Check, ExternalLink, X } from 'lucide-react'
import { cn } from '@/lib/utils'

function truncateAddress(address: string): string {
  if (address.length <= 12) return address
  return `${address.slice(0, 6)}...${address.slice(-4)}`
}

type CopyStatus = 'idle' | 'copied' | 'error'

interface AddressDisplayProps {
  address: string
  showFull?: boolean
  label?: string
  /**
   * Feeds the aria-labels only and renders no visible text. Falls back to
   * `label`, then to `"address"`. Use it to tell repeated instances apart (for
   * example "channel" and "payer" in the session table).
   */
  accessibleLabel?: string
  className?: string
}

export function AddressDisplay({
  address,
  showFull = false,
  label,
  accessibleLabel,
  className,
}: AddressDisplayProps) {
  const [copyStatus, setCopyStatus] = useState<CopyStatus>('idle')

  const explorerBase =
    process.env.NEXT_PUBLIC_STELLAR_EXPERT_URL ?? 'https://stellar.expert/explorer/testnet'

  const baseAddress = address.includes(':') ? address.split(':')[0]! : address
  const explorerType = baseAddress.startsWith('C') ? 'contract' : 'account'

  const displayAddress = showFull ? baseAddress : truncateAddress(baseAddress)
  const accessibleName = accessibleLabel ?? label ?? 'address'
  const copyLabel = `Copy ${accessibleName} ${displayAddress}`
  const linkLabel = `View ${accessibleName} ${displayAddress} on Stellar Expert (opens in new tab)`

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(baseAddress)
      setCopyStatus('copied')
    } catch {
      setCopyStatus('error')
    }
    setTimeout(() => setCopyStatus('idle'), 2000)
  }

  return (
    <span className={cn('inline-flex items-center gap-1', className)}>
      {label && (
        <span className="text-xs text-[var(--text-muted)] mr-1">{label}</span>
      )}
      <span className="font-mono text-sm text-[var(--mono)]">{displayAddress}</span>
      <button
        type="button"
        onClick={handleCopy}
        aria-label={copyLabel}
        className="inline-flex h-6 w-6 items-center justify-center rounded text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {copyStatus === 'copied' ? (
          <Check className="h-3.5 w-3.5 text-[var(--status-success)]" />
        ) : copyStatus === 'error' ? (
          <X className="h-3.5 w-3.5 text-[var(--status-error)]" />
        ) : (
          <Copy className="h-3.5 w-3.5" />
        )}
      </button>
      <a
        href={`${explorerBase}/${explorerType}/${baseAddress}`}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={linkLabel}
        className="inline-flex h-6 w-6 items-center justify-center rounded text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ExternalLink className="h-3.5 w-3.5" />
      </a>
      <span className="sr-only" role="status" aria-live="polite">
        {copyStatus === 'copied'
          ? 'Address copied'
          : copyStatus === 'error'
            ? "Couldn't copy address"
            : ''}
      </span>
    </span>
  )
}
