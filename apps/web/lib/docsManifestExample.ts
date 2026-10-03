export const DOCS_MANIFEST_EXAMPLE = {
  routedock: '1.0',
  name: 'Stellar DEX Price Feed',
  description: 'Real-time Stellar DEX price feeds with micropayment settlement',
  modes: ['x402', 'mpp-charge'],
  network: 'testnet',
  asset: 'USDC',
  asset_contract: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
  payee: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
  pricing: {
    x402: { amount: '0.001', per: 'request' },
    'mpp-charge': { amount: '0.0008', per: 'request' },
  },
  endpoints: {
    price: {
      method: 'GET',
      path: '/price',
    },
  },
  tags: ['price', 'stellar', 'dex'],
}
