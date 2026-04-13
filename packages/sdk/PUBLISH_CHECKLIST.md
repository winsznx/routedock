# @routedock/sdk Publish Checklist

Complete every step in order. Do not skip.

## Pre-publish

- [ ] **1. Build dist/**
  ```bash
  cd packages/sdk
  pnpm build
  ```
  Verify: `dist/index.js`, `dist/index.cjs`, `dist/client.js`, `dist/client.cjs`, `dist/provider.js`, `dist/provider.cjs`, and all `.d.ts` files exist.

- [ ] **2. Typecheck**
  ```bash
  pnpm typecheck
  ```
  Must exit with 0 errors.

- [ ] **3. Smoke tests**
  ```bash
  pnpm test
  ```
  All 4 smoke tests must pass.

- [ ] **4. Confirm no secrets in pack**
  ```bash
  npm pack --dry-run
  ```
  Scan the file list: no `.env`, no `*.pem`, no files containing `SECRET` in the name.

- [ ] **5. Update `repository.url`**
  In `packages/sdk/package.json`, replace `YOUR_ORG` with the actual GitHub org/user.

## Publish

- [ ] **6. Login to npm**
  ```bash
  npm login
  ```
  Verify you are logged in as the correct user: `npm whoami`

- [ ] **7. Publish**
  ```bash
  cd packages/sdk
  pnpm publish --access public
  ```
  The `--access public` flag is required for scoped packages (`@routedock/sdk`) to be publicly accessible.

## Post-publish Verification

- [ ] **8. Verify on npm registry**
  ```bash
  npm show @routedock/sdk
  ```
  Confirms: version 0.1.0, correct description, MIT license.

- [ ] **9. Test install in a clean directory**
  ```bash
  mkdir /tmp/test-install && cd /tmp/test-install
  npm init -y
  npm install @routedock/sdk
  node -e "const { RouteDockClient } = require('@routedock/sdk'); console.log('ok')"
  ```

- [ ] **10. Add npm badge to README.md**
  Once published, update the root README with the live npm badge:
  ```markdown
  ![npm](https://img.shields.io/npm/v/@routedock/sdk)
  ```
