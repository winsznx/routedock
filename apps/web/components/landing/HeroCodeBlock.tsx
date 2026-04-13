import { codeToHtml } from 'shiki'
import { HeroCodeBlockClient } from './HeroCodeBlockClient'

const CODE = `const client = new RouteDockClient({ wallet, network: 'testnet' })
const result = await client.pay('https://api.example.com/data')
// result.mode → 'x402' | 'mpp-charge' | 'mpp-session'`

export async function HeroCodeBlock() {
  const html = await codeToHtml(CODE, {
    lang: 'typescript',
    theme: 'github-dark',
    transformers: [],
  })

  return <HeroCodeBlockClient html={html} code={CODE} />
}
