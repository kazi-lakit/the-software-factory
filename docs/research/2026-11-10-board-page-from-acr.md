# Board page from ACR: proven hosted-login mechanics (research, 2026-11-10)

Read-only research. Nothing run against Blocks cloud or GitHub; no .env, credential or token files opened.
`R` = `~/scratchpad/selise/build-with-blocks/agent-control-room`, `F` = `~/scratchpad/selise/the-software-factory`, `V` = `~/scratchpad/selise/vaultS`.
Note: the checked-out ACR branch (`feat/acr-plugin`) predates the renewal fix. The fix lives on `origin/main` and `origin/fix/acr-session-renewal` (commit 9082852); cite it as `R@origin/main:apps/web/src/lib/blocks/auth.ts`.

## Headline findings (decide the plan on these)

1. **localhost will not work for login.** The hosted-login session is a Secure, domain-scoped, httpOnly cookie that browsers refuse on `http://localhost`. ACR runs its dev server over HTTPS on the project's real app domain, with a `/etc/hosts` line to 127.0.0.1 and a self-signed cert. (`R/apps/web/README.md` "Why local login needs HTTPS on the project domain"; `R/.agents/skills/blocks-frontend-local-https/SKILL.md:14-16, 74-80`.) Plan 3's "Vite on localhost" must become "Vite on `https://<app-domain>:5173`".
2. **JS never sees a token in this flow.** Cookie mode. The factory's `SdkBlocksData` can be reused unchanged in the browser with a cookie-mode `TokenSource` that returns `''` (ACR does exactly this with its twin of `SdkBlocksData`). Needs one small fix: `invalidate()` must be awaitable (see section 3).
3. **The browser needs only two swaps in the factory core:** `node:crypto` (`createHash`, `randomUUID`) and `Buffer.byteLength`, plus `branchGuard.ts` (`node:url`, `import.meta.url`) if `gates.ts` is imported. Details in section 6.
4. **Cookie lifetime is 15 min unless renewed.** Port ACR's `renewSession` (section 3).
5. The ACR custom domain is `dexwtw-ersme.slsblx.com`, the ACR project's. The factory project needs its own app domain, its own public client and its own redirect URIs. App domain for the factory: **not found** in `F/docs` (grep for `slsblx` found nothing). `blocks new web --dry-run` must be run interactively by the user to discover it (`R/docs/integration/blocks-capabilities.md:141`: "Only an interactive `blocks new web --dry-run` showed it; `blocks doctor` does not report it").

## 1. How ACR's web app was created

- Command (planned, `R/docs/superpowers/plans/2026-11-06-acr-human-ui.md:182-184`):
  - read-only domain probe, user-run in a TTY: `cd apps && blocks new web web --dry-run`
  - real scaffold: `blocks new web web --app-domain https://<host> --client-id <id> --dry-run --json`, then the same with `--yes` after approval.
  - Actual domain/client used: app-domain `https://dexwtw-ersme.slsblx.com`, client id passed with `--client-id` (`R/docs/integration/blocks-capabilities.md:141-144`). The literal command line that was run is **not recorded**; the plan form above is the closest evidence.
- CLI help (`blocks --help`, `new web`): `blocks new web <name> [--app-domain] [--client-id] [--dry-run] [--yes] [--x-blocks-key] [--blocks-api-url] [--oidc-url]`. Non-interactive callers MUST pass `--app-domain` and `--client-id` or get `interactive_input_required`. `--blocks-api-url` defaults to `https://blocksapi.<registrable-domain>`; `--oidc-url` defaults to `https://iam.seliseblocks.com`. `--client-id` must be an existing project OIDC client (`oidc_client_not_found` otherwise). `--dry-run` only reads.
- Stack (`R/apps/web/package.json`): React 18.3.1, react-dom 18.3.1, Vite ^8.2.0, `@vitejs/plugin-react` ^6.0.5, TypeScript ^5.9.3, `@tanstack/react-query` ^5.101.4, `@seliseblocks/client` ^0.3.0 (installed 0.3.0), Tailwind ^3.4.17 + postcss + autoprefixer, `selfsigned` ^2.4.1 (cert script), vitest ^5.1.0 + jsdom ^31 + Testing Library; ACR added `@noble/hashes` 2.4.0 and `zod` 4.6.7. Node engines `^20.19.0 || >=22.12.0`.
- Generated files that matter:
  - `src/lib/blocks/{config,client,auth,jwt}.ts`: env config, the single `createBlocksClient`, session logic, JWT decode helper.
  - `src/app/providers/AuthProvider.tsx`: status poll plus `login/logout/refresh`.
  - `src/app/router/{guards,routes}.tsx`: `RequireAuth`, `RedirectIfAuthenticated`; no router library (history API + `useState`, `routes.tsx:11-26`).
  - `src/app/providers/AppProviders.tsx`: TanStack `QueryClient` (`staleTime 30_000`, `refetchOnWindowFocus: false`, `retry: false`).
  - `src/features/profile/useCurrentUser.ts`: `useQuery(["iam","me"], blocksClient.iam.me)`.
  - `vite.config.ts` (HTTPS from `.cert/`, `allowedHosts`, `host`, `strictPort`), `scripts/generate-cert.mjs`, `scripts/write-release-env.mjs`, `.env.example`, `nginx.conf`, `tailwind.config.ts`, `src/app/styles.css`, `blocks/*` IaC folders (auth, data, iam, localization, logic, mail, release, storage, workflows; each a README, data has `rules.json` and `schemas/`).
  - Release: root `R/Dockerfile` (node 24 build with `ARG VITE_BLOCKS_*`, nginx-unprivileged on 8080, SPA fallback `try_files ... /index.html`, `R/apps/web/nginx.conf`). Deploy via Blocks Release; not needed for plan 3 (localhost-only).

## 2. OIDC / hosted login setup

### Commands (project-scoped; run `--dry-run --json` first, `--yes` only after approval)

From `R/.agents/skills/blocks-bootstrap/flows/oidc-client.md:21-56` and `blocks-iam-sso-oidc-configuration/SKILL.md:28-55`; flag list verified against local `blocks --help`:

```
blocks auth oidc-clients list --json                 # reuse first
blocks auth oidc-clients save \
  --client-display-name "Factory Board (local)" \
  --client-type public \
  --redirect-uris "https://<app-domain>:5173/login/callback" \
  --scope "openid profile" \
  --allowed-scopes openid,profile \
  --require-pkce --active \
  --register-as-identity-provider --auto-redirect \
  --dry-run --json
blocks auth idp list --json                          # authorizationUrl/tokenUrl/userInfoUrl must be non-null
blocks auth idp update <providerItemId> --authorization-url ... --token-url ... --user-info-url ...   # only if null; copy values from the tenant discovery doc, never hand-compose
blocks auth config get --json                        # isOidcEnabled must be true
blocks auth config save --oidc-enabled --dry-run --json
```

- Redirect URI format: `https://<app-domain>:5173/login/callback`, byte for byte including the port (`R/apps/web/README.md` "Login setup"; ACR's was `https://dexwtw-ersme.slsblx.com:5173/login/callback`, `blocks-capabilities.md:142`). Add every origin the app is served from. To add one later: re-save with `--item-id <clientId> --redirect-uris "<full list>"`; the CLI merges unmentioned fields (`SKILL.md:30` of sso-configuration).
- `--client-type public` is mandatory in practice: without it the client is stored as confidential (`client_secret_post`) and may request client_credentials (`oidc-client.md:37`; CLI help).
- **`openid` scope gotcha** (`blocks-capabilities.md:143`): ACR's client and provider were created with scope `offline_access` only; hosted login then refused with "scope must include 'openid'". Fix used: `oidc-clients save --item-id <id> --allowed-scopes openid,profile,offline_access --scope "openid profile offline_access"` and `auth idp update <providerId> --scope "openid profile offline_access"` (provider update kept all other fields, read back). Pass `openid` in both `--scope` and `--allowed-scopes` at creation and verify with `oidc-clients get` and `idp get`.
- `--use-tokens-cookie` flag exists on `oidc-clients save` (CLI help). ACR's docs say the client "keeps both tokens in httpOnly cookies (useTokensCookie)" (`V/knowledge/blocks-hosted-login-session-renewal.md:3`; `R@origin/main auth.ts:105-107`), but **no ACR doc records the exact flag used at creation** ("not found"). Treat it as: set `--use-tokens-cookie` explicitly and confirm with `oidc-clients get` after creation, rather than rely on a default.
- `blocks new web --client-id` side effects (`blocks-capabilities.md:144`): flipped the project's auth config `isOidcEnabled` false to true, `accountActivationPath` `activate` to `oidc/activate/`, `accountActionBaseUrl` `https://dexwtw.slsblx.com` to `https://iam.seliseblocks.com`. A user created without a password then activated from the email on Blocks' hosted page (first attempt did not take, second did). The CLI help says it may enable OIDC and that `--yes` should be passed only after approving that tenant mutation. Alternative that avoids guessing: `blocks iam users activate <id> --reason ...` (plan used it, `human-ui.md` Task 3 step 5).
- Roles for the user: the factory already plans `blocks iam users update-access <userId> --roles factory-owner` (`F/docs/setup/blocks-project-setup.md:66`).

### Env vars (`R/apps/web/.env.example`, `src/lib/blocks/config.ts:1-12`)

| Var | Meaning |
|---|---|
| `VITE_BLOCKS_API_URL` | `https://blocksapi.<registrable-domain>` for a custom domain (ACR: `https://blocksapi.slsblx.com`). Must share the app's registrable domain or the cookie never lands (`blocks-frontend-local-https/SKILL.md:96-103`). |
| `VITE_BLOCKS_X_BLOCKS_KEY` | tenant id; sent as `x-blocks-key` and as tenant on login |
| `VITE_BLOCKS_APP_DOMAIN` | `https://<app-domain>` |
| `VITE_BLOCKS_OIDC_URL` | `https://iam.seliseblocks.com` |
| `VITE_BLOCKS_OIDC_CLIENT_ID` | public client id (empty means the login page shows a setup notice, `config.ts:18-20`) |
| `VITE_BLOCKS_OIDC_SCOPE` | default `openid profile` |
| `VITE_BLOCKS_DEV_HOST` / `VITE_BLOCKS_DEV_PORT` | host (no scheme) and port (5173) used by `vite.config.ts`, hosts file and cert |

### Local run (`R/apps/web/README.md` "To run it locally")
`npm run cert` (writes `.cert/dev-{key,cert}.pem`, gitignored), add `127.0.0.1 <host>` to `/etc/hosts` (sudo, user runs it), optionally trust the cert, `npm run dev`, open `https://<host>:5173` in a normal browser. The desktop app's built-in browser blocks the dev server's scripts on this host (`ERR_BLOCKED_BY_CLIENT`, `blocks-capabilities.md:145`). `vite.config.ts` (`R/apps/web/vite.config.ts`): `host: domain`, `allowedHosts: [domain]` (else "Blocked request. This host is not allowed"), `https` from `.cert`, `strictPort: true` (port is part of the registered redirect URI).

### Flow in the app
- Login: `/login` page calls `startLogin(returnTo)`: saves `returnTo` in `sessionStorage["blocks-app:oidc-return-to"]`, then `blocksClient.auth.idp.redirectToProvider()` (`auth.ts:163-170`). SDK calls the IdP initiate endpoint and `window.location.assign(redirect_uri)` (SDK `dist/auth/auth-client.js:177-183`). `oidc` block is passed to `createBlocksClient` (`client.ts:19-23`); SDK default redirect is `${origin}/login/callback`.
- Callback: `/login/callback` renders `CallbackPage` (`R/apps/web/src/acr/auth-pages.tsx:70-95`), once-guarded by a ref, calls `completeLogin(window.location.href)` (`auth.ts:172-191`) which does `blocksClient.auth.idp.callback(url)` (`GET /iam/v4/idp/callback`, `credentials: include`). IAM sets cookies on that response; a body with no token is success. Error body gives `error_description`. Then `refresh()` and navigate to `returnTo`. Never wrap the callback route in `RequireAuth`.
- "Signed in" = `blocksClient.auth.userInfo()` (`GET /iam/v4/auth/me`) succeeds (`auth.ts:155-161`, `AuthProvider.tsx:31-35`). Not token presence.
- Logout: `blocksClient.auth.logout({refreshToken: getRefreshToken()})` best effort, clear local tokens, `refresh()` (`auth.ts:193-199`, `AuthProvider.tsx:61-64`).
- Guards: `RequireAuth` redirects to `/login?returnTo=...` when status is `unauthenticated` (`guards.tsx:14-29`); `RedirectIfAuthenticated` sends `/login` to `/` (`guards.tsx:31-40`).

## 3. Session model in the browser (decides the SdkBlocksData reuse)

- **httpOnly cookie, not bearer.** `README.md` of `apps/web`: "IAM's hosted login sets the session as a Secure, httpOnly cookie by default -- this app never reads, stores, or refreshes a token itself". `R/apps/web/src/lib/blocks/auth.ts:5-9` says the same; the bearer path (`persistTokens`, `sessionStorage["blocks-app:access-token"]`) only activates if a tenant's OIDC config returns tokens in the body.
- **Does JS see an access token? No** (cookie flow). `getValidAccessToken()` resolves `undefined` (`auth.ts:91-95`, and at `origin/main:93-98` returns `undefined` when no refresh token).
- **`credentials: 'include'`: yes, always, inside the SDK.** `@seliseblocks/client` 0.3.0: `dist/http/http-client.js:47` (Data/IAM/etc.) and `dist/auth/auth-client.js:405` (Auth/IdP). **Authorization header: only when the `accessToken` resolver returns a truthy string** (`http-client.js:38-42`: `if (token) headers.set("Authorization", ...)`; `auth-client.js:397-399`). `x-blocks-key` is always set (`http-client.js:34`). A custom `fetch` passed to `createBlocksClient` receives the init with `credentials: "include"` untouched (ACR relies on this through `withTimeout`).
- **Data GraphQL**: `client.data.graphql({operationName, query, variables})` is `POST ${apiUrl}/data/v4/gateway` through the same http client (SDK `dist/data/data-client.js:247-256`), so cookies ride along.
- **Reuse of the factory's `SdkBlocksData`: works with a cookie `TokenSource`.** ACR's version is the twin of `F/core/src/blocks/data.ts` (`R/packages/claude-connector/src/blocks-data-sdk.ts:27-55`, same per-attempt client, same 401 retry loop) and is fed this source (`R/apps/web/src/acr/client.ts:73-77`):
  `const token = { token: async () => (await getValidAccessToken()) ?? "", invalidate: async () => { await forceRefreshAccessToken(); } }`.
  The factory's `TokenSource` is `{ get(): Promise<string>; invalidate(): void }` (`F/core/src/blocks/token.ts:4-9`) and `SdkBlocksData.send` does `accessToken: () => token` then `this.p.token.invalidate(); continue;` (`F/core/src/blocks/data.ts:73, 91`). With `get()` returning `''` no Authorization header is sent and the browser sends the cookie. No cookie-mode `SdkBlocksData` variant is needed.
  **One required change:** `invalidate()` is sync and not awaited at `data.ts:91`. In cookie mode the 401 retry must wait for the renewal request to finish, or the retry races it and 401s again. Change the interface to `invalidate(): void | Promise<void>` and `await this.p.token.invalidate()` (the existing `ClientCredentialsToken.invalidate` stays valid).
  Also: the factory does `new SdkBlocksData({... fetch})` through `withTimeout` using `AbortSignal.timeout`/`AbortSignal.any` (`data.ts:54-58`); both exist in current Chrome/Firefox/Safari 17.4+, which is fine for a localhost app.
- **Renewal fix** (`R@origin/main:apps/web/src/lib/blocks/auth.ts:101-141`, `AuthProvider.tsx:16-53`, commit 9082852; vault `V/knowledge/blocks-hosted-login-session-renewal.md`):
  - Problem: access cookie lasts `accessTokenValidForNumberMinutes` (15 in ACR) and the scaffold only refreshes when JS holds a refresh token, which cookie mode never does, so every session died ~15 min after sign-in.
  - Endpoint: `POST /iam/v4/oidc/token`, `grant_type=refresh_token` plus `client_id`, **no `refresh_token` field**, `credentials: include`. This is exactly `blocksClient.auth.oidc.refreshToken({})`. Success: 200 `cookie_set: true`, fresh cookies, no token in body. No cookie: 400 `invalid_request` "refresh token not found"; the SDK does NOT throw on that 400, so check `typeof response.error === "string"` (`rejected`). `POST /iam/v4/auth/refresh` with an empty body does not read the cookie (400).
  - `renewSession(): Promise<"renewed"|"rejected"|"unavailable">`, one in flight at a time; a network failure is `unavailable` and must never sign anyone out.
  - Timing: status check every `STATUS_POLL_MS = 5 * 60_000` (`AuthProvider.tsx:22`), each tick while signed in also renews; also renew once before treating a failed `auth/me` as signed out; on `visibilitychange` to visible the status is re-checked; a 401 from a protected call renews too (`forceRefreshAccessToken` calls `renewSession`, and `rejected` fires `notifySessionExpired`). Do NOT renew inside `getValidAccessToken` (runs before every request).
  - Remaining limits: `refreshTokenValidForNumberMinutes` 30 sliding, `absoluteRefreshTokenValidForNumberMinutes` 300; read via `blocks auth config get`. After 300 min the user must sign in again whatever happens.

## 4. How ACR pages call Blocks Data; errors; roles

- **Data**: not hand-written fetch; through `createSdkBlocksData` -> SDK `client.data.graphql`. The app wires `createBlocksStore({data})` and `createBlocksHumanWriter(data)` (`R/apps/web/src/acr/client.ts:73-86`) and pages use TanStack Query hooks (`R/apps/web/src/acr/use-acr-overview.ts:18-42`: `useQuery`/`useQueries`, `refetchInterval: 30_000`, `refetchOnWindowFocus: true`, query keys `["acr","workflows"]`, `["acr","overview",id]`). Writes are plain async functions returning an outcome union (`SendOutcome`: `sent | failed{code} | unknown{sent}`), not `useMutation` (`client.ts:13, 41-52`).
- **Timeout**: `withTimeout(10_000)` around fetch (`client.ts:29, 77`), because the SDK client has none.
- **Errors**: the data layer returns kinds (`transport-error`, `http-error{status}`, `graphql-error`; `blocks-data-sdk.ts:34-54`), no messages or tokens. On 401 it calls `token.invalidate()` once and retries (`blocks-data-sdk.ts:47-50`). The app's reaction to a dead session is NOT a per-call redirect: `onSessionExpired` listeners and the 5-minute / visibility `auth/me` poll flip `status` to `unauthenticated`, and `RequireAuth` redirects to `/login?returnTo=...` (`guards.tsx:21-25`). Unsent text is held in memory and the drawer shows `SESSION_ENDED` copy instead of redirecting (`R/apps/web/src/acr/copy.ts:21`, `unsent-text.tsx`). Query `retry: false`.
- **Roles**: `blocksClient.iam.me()` (heavier full profile call, `useCurrentUser.ts:6-13`), roles at `me.data.data.roles` (string array; `blocks-capabilities.md:145` "Roles come from `blocksClient.iam.me()` at `data.roles`"). Checked fail-closed in `R/apps/web/src/acr/roles.ts:6-19` (`hasRole`: object, `roles` array of strings, includes the role). The `auth/me` claims (`userInfo()`) are used only for "signed in", not for roles. For the factory: `isFactoryOwner(profile)` = same `hasRole(profile, 'factory-owner')`. Server-side data rules still enforce the role (UI gating is convenience only).

## 5. Gotchas

- **HTTPS + project domain required locally** (headline 1). Symptom of using `http://` or `localhost`: login redirects back, app looks signed in for a second, then bounces to logged-out (`blocks-frontend-local-https/SKILL.md:12, troubleshooting table`).
- **Custom domain: `VITE_BLOCKS_API_URL` must be `https://blocksapi.<registrable-domain>`** (e.g. `https://blocksapi.slsblx.com`), not `api.seliseblocks.com`, or the cross-site cookie is never stored and `/iam/me`, logout and callback silently fail.
- **CORS for localhost against api.seliseblocks.com: not found** in any ACR doc or vault note (the only CORS notes are unrelated: genesis, storage). Because cookie auth forces the real domain on HTTPS, a plain-localhost cross-origin setup was never tried. Do not assume it works.
- **Anything that returned HTML**: `blocks data config get` failed with "HTML returned for `/data/v4/configurations`" (`blocks-capabilities.md:13`; `docs/superpowers/specs/2026-11-05-agent-control-room-design.md:359`): the endpoint returned HTML, which does not prove the feature is absent. Not a browser-app issue; a reminder to treat a non-JSON answer as "unknown", not "none".
- **`isOidcEnabled`**: false until enabled; all of client + identity provider + `isOidcEnabled: true` must agree (`oidc-client.md:3`). A provider with a null `authorizationUrl` sends the browser to the app's own origin with OIDC params (`oidc-client.md:64`).
- **Activation**: a user created without a password must activate on IAM's hosted page (`accountActionBaseUrl` pinned to `https://iam.seliseblocks.com`); ACR's first attempt failed and the second worked. Ask the user to run the password step themselves; never handle a password.
- **15-minute sign-out bug**: section 3. Both tokens are httpOnly; session ends at first access-cookie expiry unless `renewSession` runs.
- **Scaffold CSS** (`V/knowledge/blocks-scaffold-css-gotchas.md`): mockup class names `grid` and `outline` collide with Tailwind utilities the scaffold's content scan emits (`.outline` gives `outline-style: solid` to every button); the global `styles.css` has a bare `aside` rule (240px, flex column, white, right border) that hits any `<aside>`. Scope or rename, reset per component; jsdom tests cannot see it, so grep the built CSS. ACR's `acr.css` has a guard test for clashes (`HANDOFF.md:55`).
- **Kaniko / Release**: Blocks Release builds from the repo-root `Dockerfile` with `ARG ci_build` and public `VITE_BLOCKS_*` build args (`R/Dockerfile`, `R/apps/web/README.md` "Blocks Release deployment"); `blocks release deploy --register-callback` registers the new origin's callback. Specific kaniko notes: **not found**. Not needed for a localhost-only Board.
- **Desktop app's built-in browser** blocks the dev host scripts; use a normal browser (`blocks-capabilities.md:145`).
- **`blocks new web` into a repo with workspaces**: ACR added `apps/*` to root workspaces; the scaffold is a standalone app otherwise. `.env` is gitignored by the scaffold; only `.env.example` is committed.

## 6. Node-only APIs in the factory core and the smallest browser-safe change

Scanned: `core/src/blocks/{store,data,update,schema,token}.ts`, `core/src/{store,types,status,history,gates,defaults,limits}.ts` (grep of `node:`, `Buffer`, `process`, `import.meta`, `crypto`, `fs`). Files not listed here had no Node-only use.

| File:line | API | Fix |
|---|---|---|
| `blocks/store.ts:1` `import { createHash, randomUUID } from 'node:crypto'` | `createHash`, `randomUUID` | see below |
| `blocks/store.ts:74` `createHash('sha256').update(s,'utf8').digest('hex')` (used sync at 134, 262) | sha256 hex | `@noble/hashes/sha2` `sha256` + hex (sync, same hex output) |
| `blocks/store.ts:212, 295, 367` `randomUUID()` | UUID | `globalThis.crypto.randomUUID()` (browsers over HTTPS or localhost = secure context; Node 24) |
| `blocks/store.ts:260` `Buffer.byteLength(body,'utf8')` | `Buffer` | `new TextEncoder().encode(body).length` |
| `blocks/update.ts:1` `import { randomUUID } from 'node:crypto'`, `:60` default `p.newWriteId ?? randomUUID` | UUID | `globalThis.crypto.randomUUID()` (wrap: `() => globalThis.crypto.randomUUID()` so `this` is bound) |
| `store.ts:1-3` `node:crypto` (`randomBytes`), `node:fs` (many), `node:path` (`dirname`); `store.ts:285` `setTimeout` (fine); `store.ts:334` `process.pid` | file store | **Do not import in the browser.** Node-only by design; import only `blocks/*` and the pure modules. |
| `gates.ts:1` imports `isProtected` from `branchGuard.ts`; `branchGuard.ts:1,6` `node:url` `fileURLToPath` + `import.meta.url` (`HOOK_PATH`, a top-level side effect) | Node URL/path | Move `isProtected` (and `ProtectedBranchError` if needed) into a pure file, or move `HOOK_PATH` to a Node-only module. Without this, importing `gates.ts` into Vite breaks (`node:url` externalized, `fileURLToPath` fails at module load). |
| `blocks/data.ts:54-58` `AbortSignal.timeout`, `AbortSignal.any`, `globalThis.fetch` | web standard | fine in current browsers |
| `blocks/token.ts` | `@seliseblocks/client` only; `ClientCredentialsToken`/`sdkMint` use client credentials (a secret) | **Never bundle `blocks/credential.ts`** (Keychain via `../secrets.js`) or `ClientCredentialsToken` in the browser; use a cookie `TokenSource` |
| `blocks/credential.ts` imports `../secrets.js` (Keychain via exec) | Node-only | Not importable in the browser |
| `types.ts, status.ts, history.ts, defaults.ts, limits.ts, blocks/schema.ts` | none | pure |
| `zod` (credential.ts) | pure JS | fine |

Smallest change set (matches what ACR did, `R/docs/superpowers/plans/2026-11-06-acr-human-ui.md:7`, spec "Browser-safe core"): (1) in `blocks/store.ts` and `blocks/update.ts` replace `node:crypto` with `@noble/hashes` sha256 + `globalThis.crypto.randomUUID()`, `Buffer.byteLength` with `TextEncoder`; (2) split `branchGuard.ts` so the pure predicate has no `node:url`; (3) make `TokenSource.invalidate` awaitable; (4) the browser entry imports `blocks/{store,data,update,schema}.ts`, `gates.ts` etc., never `store.ts`, `credential.ts`, `secrets.ts`, `git.ts`, `cli.ts`. Why `@noble/hashes` and not `crypto.subtle`: `subtle.digest` is async, but `sha256()` is called synchronously in `blocks/store.ts:134,262`; ACR hit the same constraint (spec "Browser-safe core": "It is synchronous, so call sites do not change"). Hash output must not change (stored `bodySha256` and event keys depend on it; add a golden-hash test).

## 7. ACR web code generic enough to port (copy and adapt, do not import)

| File (under `R/apps/web/`) | Purpose / what to adapt |
|---|---|
| `src/lib/blocks/config.ts` | env to config + `isLoginConfigured`; drop `keyFunctionId`; default scope `openid profile` |
| `src/lib/blocks/client.ts` | the single `createBlocksClient` with `oidc` block, `accessToken`/`onUnauthorized` hooks |
| `src/lib/blocks/auth.ts` (use the `origin/main` version) | `startLogin`, `completeLogin`, `logout`, `fetchSessionClaims`, `renewSession`, `onSessionExpired`; the bearer branch can be deleted for a cookie-only app |
| `src/lib/blocks/jwt.ts` | not needed in cookie mode (only for the bearer path); omit |
| `src/app/providers/AuthProvider.tsx` (+ `origin/main` renew timing) | `status` of loading/authenticated/unauthenticated, 5-min poll, visibility re-check, `onSessionExpired` hook |
| `src/app/router/guards.tsx`, `routes.tsx` | `RequireAuth` / `RedirectIfAuthenticated`, tiny history-API router (no router dependency); `/login`, `/login/callback` |
| `src/acr/auth-pages.tsx` | `LoginPage`, `CallbackPage`, `LoadingPage` (strip ACR copy/styling) |
| `src/features/profile/useCurrentUser.ts` | `useQuery(["iam","me"])`, enabled only when authenticated |
| `src/acr/roles.ts` | fail-closed `hasRole`; rename to `isFactoryOwner` |
| `src/app/providers/AppProviders.tsx` | QueryClient defaults |
| `src/acr/client.ts` (token source + `createSdkBlocksData` wiring only, lines 73-77) | the `''`-token cookie source and `withTimeout` wiring; the rest is ACR-specific |
| `src/acr/use-acr-overview.ts` | pattern for `useQuery`/`useQueries` with polling for a board read |
| `src/acr/unsent-text.tsx`, `copy.ts:21` | keep unsent edits across a session end instead of redirecting; useful for the Board's edit forms |
| `vite.config.ts`, `scripts/generate-cert.mjs`, `.env.example` | HTTPS dev on the project domain; `strictPort`; `allowedHosts` |
| `vitest.config.ts` + `src/test/*` | jsdom + Testing Library setup, mocking `fetchSessionClaims`/`blocksClient` (`pending-page.test.tsx:14` style) |

## Checklist for plan 3 (derived)

1. Ask the user to run `blocks new web --dry-run` (TTY) in the factory repo to learn the app domain; set `VITE_BLOCKS_API_URL=https://blocksapi.<registrable-domain>`.
2. Create the public client with `--scope "openid profile" --allowed-scopes openid,profile --require-pkce --use-tokens-cookie --register-as-identity-provider --auto-redirect`, redirect `https://<app-domain>:5173/login/callback`; verify `idp list` and `auth config get` (`isOidcEnabled`).
3. Cert + hosts line (user runs `sudo`), Vite HTTPS config as ACR.
4. Browser-safe core changes (section 6) with a golden-hash test, then a cookie `TokenSource` that returns `''` and renews via `renewSession`, with an awaited `invalidate`.
5. Roles: `iam.me()` -> `data.roles` includes `factory-owner`; fail closed; rely on Data rules for enforcement.
6. Live gate: user signs in at `https://<app-domain>:5173` in a normal browser; confirm a Data read through the cookie before building pages.
