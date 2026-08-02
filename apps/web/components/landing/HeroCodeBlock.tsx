import type { ReactElement } from 'react'
import { HeroCodeBlockClient } from './HeroCodeBlockClient'
import { HERO_CODE_HTML, HERO_CODE } from './heroCodeHtml'

export function HeroCodeBlock(): ReactElement {
  return <HeroCodeBlockClient html={HERO_CODE_HTML} code={HERO_CODE} />
}
