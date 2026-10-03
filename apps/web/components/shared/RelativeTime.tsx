'use client'

import { useSyncExternalStore } from 'react'
import { formatRelativeTime, getNow, subscribeNow } from '@/lib/time'

interface RelativeTimeProps {
  date: string
}

export function RelativeTime({ date }: RelativeTimeProps) {
  const now = useSyncExternalStore(subscribeNow, getNow, () => null)
  const isoDate = new Date(date).toISOString()

  if (now === null) {
    return <time dateTime={isoDate} title={isoDate}>{isoDate}</time>
  }

  return <time dateTime={isoDate} title={isoDate}>{formatRelativeTime(date, now)}</time>
}