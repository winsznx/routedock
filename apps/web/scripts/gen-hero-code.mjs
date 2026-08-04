import { codeToHtml } from 'shiki'
import { writeFileSync } from 'fs'

const CODE = `const client = new RouteDockClient({ wallet, network: 'testnet' })
const result = await client.pay('https://provider.stellar.app/price')
// result.mode → 'x402' | 'mpp-charge' | 'mpp-session'`

const html = await codeToHtml(CODE, { lang: 'typescript', theme: 'github-dark' })

const out = `// Pre-highlighted at build time with Shiki so the hero snippet needs no runtime
// syntax highlighter. Cloudflare Workers disallow Shiki's Oniguruma WASM engine and
// its hast serializer deps don't bundle cleanly under pnpm — this sidesteps both.
// Regenerate with: node scripts/gen-hero-code.mjs
export const HERO_CODE_HTML = ${JSON.stringify(html)}
export const HERO_CODE = ${JSON.stringify(CODE)}
`
writeFileSync('components/landing/heroCodeHtml.ts', out)
console.log('wrote heroCodeHtml.ts —', html.length, 'chars of HTML')
