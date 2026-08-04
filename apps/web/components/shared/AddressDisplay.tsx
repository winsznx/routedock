'use client'

import { useState } from 'react'
import { Copy, Check, ExternalLink } from 'lucide-react'
import { cn } from '@/lib/utils'

function truncateAddress(address: string): string {
  if (address.length <= 12) return address
  return `${address.slice(0, 6)}...${address.slice(-4)}`
}

interface AddressDisplayProps {
  address: string
  showFull?: boolean
  label?: string
  className?: string
}

export function AddressDisplay({ address, showFull = false, label, className }: AddressDisplayProps) {
  const [copied, setCopied] = useState(false)

  const explorerBase =
    process.env.NEXT_PUBLIC_STELLAR_EXPERT_URL ?? 'https://stellar.expert/explorer/testnet'

  const baseAddress = address.includes(':') ? address.split(':')[0]! : address
  const explorerType = baseAddress.startsWith('C') ? 'contract' : 'account'

  async function handleCopy() {
    await navigator.clipboard.writeText(baseAddress)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <span className={cn('inline-flex items-center gap-1', className)}>
      {label && (
        <span className="text-xs text-[var(--text-muted)] mr-1">{label}</span>
      )}
      <span className="font-mono text-sm text-[var(--mono)]">
        {showFull ? baseAddress : truncateAddress(baseAddress)}
      </span>
      <button
        onClick={handleCopy}
        aria-label="Copy address"
        className="text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors"
      >
        {copied ? (
          <Check className="h-3.5 w-3.5 text-[var(--status-success)]" />
        ) : (
          <Copy className="h-3.5 w-3.5" />
        )}
      </button>
      <a
        href={`${explorerBase}/${explorerType}/${baseAddress}`}
        target="_blank"
        rel="noopener noreferrer"
        aria-label="View on Stellar Expert"
        className="text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors"
      >
        <ExternalLink className="h-3.5 w-3.5" />
      </a>
    </span>
  )
}
