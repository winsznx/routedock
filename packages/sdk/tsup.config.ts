import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    client: 'src/client/index.ts',
    provider: 'src/provider/index.ts',
    react: 'src/react/index.ts',
    testing: 'src/testing/index.ts',
    'provider/hono': 'src/provider/hono.ts',
    'provider/fastify': 'src/provider/fastify.ts',
    schema: 'src/schema.ts',
  },
  format: ['cjs', 'esm'],
  dts: true,
  clean: true,
  splitting: false,
  sourcemap: false,
  treeshake: true,
  external: ['react', 'react-dom', 'express', 'fastify'],
})
