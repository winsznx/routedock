'use client'

import { useState } from 'react'
import { Copy, Check, X } from 'lucide-react'

interface HeroCodeBlockClientProps {
  html: string
  code: string
}

type CopyStatus = 'idle' | 'copied' | 'error'

export function HeroCodeBlockClient({ html, code }: HeroCodeBlockClientProps) {
  const [copyStatus, setCopyStatus] = useState<CopyStatus>('idle')

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(code)
      setCopyStatus('copied')
    } catch {
      setCopyStatus('error')
    }
    setTimeout(() => setCopyStatus('idle'), 2000)
  }

  return (
    <div className="relative rounded-xl bg-[#0D1117] border border-white/10 overflow-hidden font-mono text-xs sm:text-sm">
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-white/10">
        <div className="flex items-center gap-1.5">
          <span className="h-3 w-3 rounded-full bg-[#FF5F56]" />
          <span className="h-3 w-3 rounded-full bg-[#FFBD2E]" />
          <span className="h-3 w-3 rounded-full bg-[#27C93F]" />
        </div>
        <button
          onClick={handleCopy}
          aria-label="Copy code"
          className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-white/40 hover:text-white/80 hover:bg-white/5 transition-colors"
        >
          {copyStatus === 'copied' ? (
            <>
              <Check className="h-3.5 w-3.5" />
              Copied
            </>
          ) : copyStatus === 'error' ? (
            <>
              <X className="h-3.5 w-3.5 text-[var(--status-error)]" />
              <span className="text-[var(--status-error)]">Copy failed</span>
            </>
          ) : (
            <>
              <Copy className="h-3.5 w-3.5" />
              Copy
            </>
          )}
        </button>
      </div>
      <div
        className="p-5 [&_pre]:!bg-transparent [&_code]:text-sm [&_pre]:overflow-x-auto"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  )
}
