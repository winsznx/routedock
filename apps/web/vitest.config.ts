import { defineConfig } from 'vitest/config'
import path from 'node:path'

export default defineConfig({
  esbuild: { jsx: 'automatic' },
  resolve: {
    alias: {
      // Match the @/* path alias defined in tsconfig.json
      '@': path.resolve(__dirname, '.'),
    },
  },
  test: {
    // Run only pure-logic tests — exclude Next.js page/component files which
    // require React and the Next.js runtime to import correctly.
    include: ['lib/__tests__/**/*.test.{ts,tsx}'],
    environment: 'node',
  },
})
