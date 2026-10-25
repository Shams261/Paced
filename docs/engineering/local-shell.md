# Local dashboard and API

## Start and stop

Use Node 26.10.0 and install the pinned lockfile dependencies with `npm ci --ignore-scripts`. Run `npm run dev` from the repository root. Both servers bind to 127.0.0.1 on OS-selected available ports. Read the printed dashboard URL; ports change on restart. Existing listeners are not stopped. Press Ctrl+C in that launcher session to close its own API and Vite servers. Startup failure closes resources created by this launcher.

`npm run demo` remains the separate campaign simulator. The new shell does not replace it.

## Boundaries

- `apps/dashboard`: React/TypeScript/Vite views for prospects, campaigns and activity queue; search, list filters, refresh and hash navigation.
- `apps/api`: local Hono read-only fixtures; GET `/api/health` and GET `/api/v1/snapshot`. Other methods return 405 and unknown GET routes return 404.
- `packages/shell-contracts`: runtime-validated shared snapshot with campaign-engine status types. Domain transitions remain in the engine.
- `tools/local-shell/dev.ts`: loopback launcher and same-origin `/api` proxy. No cloud deployment configuration is provided.

All records are fictional. No login, database, persistence, account connection or send authority exists. Creation and sending controls stay disabled. A loading view, failure with retry and no-match view prevent silent fake success. Superseded requests are aborted. Do not put real profile or credential data into these fixtures.

## Verification

Run `npm run typecheck`, `npm test`, `npm run format:check`, `npm run build` and `python3 scripts/check_docs.py`. UI tests use jsdom; real-browser smoke observations are recorded separately. A dashboard bundle is not proof of hosted deployment. Database integration is now available separately through the [database guide](database.md); this shell still serves fictional fixtures. No extension build, automated Playwright suite or live LinkedIn test is configured.
