/**
 * Optional, env-gated privileged-UI unlock for a PUBLIC-IP web bind.
 *
 * PROBLEM THIS SOLVES (see below for the full chain):
 * The harness gates two client UI capabilities behind `ctx.connection.isLoopback`
 * — Settings→Models persistence (host vs in-memory) and the "Open configuration
 * file" button. `isLoopback` is computed IN THE BROWSER and is true only when the
 * page authority is 127.0.0.1/localhost, or when a `globalThis.__DSH_TRANSPORT__`
 * global declares `ownsHost:true`. It NEVER consults the server's `--trusted-host`
 * list. So a page served over a public IP (e.g. https://47.86.163.132) drops
 * Settings→Models into memory mode and the page throws:
 *   "加载提供方目录失败: settings are unavailable in this browser"
 * even though the server's /api trust fence (isTrustedApiRequest) already accepts
 * that host and would happily answer settings/describe.
 *
 * WHAT THIS DOES:
 * When (and ONLY when) the operator sets the env switch, this pushes one
 * structured index-injection row so the served index.html carries, in <head>,
 * ahead of the client bundle:
 *   <script>globalThis["__DSH_TRANSPORT__"] = {"ownsHost":true}</script>
 * That flips `isLoopback` to true for the page, so settings use host persistence
 * and the config-file button returns.
 *
 * WHY IT IS SAFE / SIDE-EFFECT-FREE:
 * The stub carries ONLY `ownsHost`. The connection RPC carrier is
 * `createWebConnectionRpc(transport?.fetch, ...)` which falls back to the page's
 * global fetch when `fetch` is absent (identical to having no transport at all),
 * and the module loader only reads `transport?.loadBundle` (absent → bundles keep
 * loading over HTTP). So nothing about transport/bundle behavior changes; only the
 * `ownsHost` branch of the isLoopback computation is affected.
 *
 * WHY IT IS OPT-IN (the operator's explicit switch):
 * This relaxes a deliberate client-side gate, so it defaults OFF. It is only
 * appropriate on a bind that is already fronted by an auth gate (this deployment
 * runs dsh-web-auth in front of the public bind) AND whose host is declared via
 * --trusted-host (the /api fence already trusts it). Set the env var to turn it
 * on; unset (default) leaves stock behavior byte-for-byte unchanged.
 *
 * PLACEMENT NOTE:
 * This lives in dsh-ego-browser only because it is the host-side plugin that
 * builds+deploys in this environment and already owns a `webServer` inject seat;
 * it is otherwise independent of the ego browser feature. Kept in its own module,
 * clearly named, env-gated, so it is greppable and cannot become a hidden
 * side effect. See also the deployment's profile cordis.patch.yml, whose
 * `configPlaneAuthenticated` rows describe a DIFFERENT (upstream/future) mechanism
 * that does not exist in the currently deployed harness code.
 */

import type { EgoContext } from './types.ts'

/**
 * Env switch enabling the unlock. Chosen name is explicit about intent:
 * "trust this remote (non-loopback) UI with the privileged surface".
 */
export const TRUST_REMOTE_UI_ENV = 'DSH_TRUST_REMOTE_UI'

/** Truthy values that turn the switch on. Anything else (incl. unset) = off. */
function switchOn(raw: string | undefined): boolean {
  if (raw === undefined) return false
  const v = raw.trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'yes' || v === 'on'
}

/**
 * One structured index-injection row: assign the transport stub global. The
 * webserver renders `{kind:'global'}` rows as a JSON-serialized `<script>` in
 * <head>, before the client bundle, which is exactly where client-connection
 * reads it during apply().
 */
interface GlobalInjectionRow {
  kind: 'global'
  name: string
  value: unknown
}

/**
 * Register the env-gated __DSH_TRANSPORT__ injection on the web shell.
 *
 * No-op unless the env switch is on and the host exposes the index-inject event
 * (i.e. a real web server). Safe to call on every host; headless/TUI hosts
 * without `ctx.on` or the web server simply do nothing.
 *
 * @param ctx - a context that has resolved `webServer` (the nested webServer
 *   inject callback), so the index-inject event is available.
 * @returns true when the injection was registered, false when skipped.
 */
export function registerRemoteUiTrust(ctx: EgoContext): boolean {
  if (!switchOn(process.env[TRUST_REMOTE_UI_ENV])) return false
  if (typeof ctx.on !== 'function') return false
  const row: GlobalInjectionRow = {
    kind: 'global',
    name: '__DSH_TRANSPORT__',
    value: { ownsHost: true },
  }
  ctx.on('webserver/index-inject', (...args: unknown[]) => {
    const table = args[0]
    // Do not clobber a real transport (e.g. a worker shell that legitimately
    // set the global): only contribute the stub when nobody else has.
    if (!Array.isArray(table)) return
    const already = table.some(
      (r) => typeof r === 'object' && r !== null
        && (r as { name?: unknown }).name === '__DSH_TRANSPORT__',
    )
    if (already) return
    table.push(row)
  })
  ctx.logger?.info?.(
    `ego-browser: ${TRUST_REMOTE_UI_ENV} on — injecting __DSH_TRANSPORT__.ownsHost so the public-IP UI uses host settings persistence`,
  )
  return true
}
