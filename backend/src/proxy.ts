/**
 * Outbound HTTP through a proxy.
 *
 * Every request this service makes — YouTube, BotGuard, googlevideo — must leave
 * from the same egress IP, because YouTube binds playback to the IP that
 * negotiated it. On a datacenter host that IP is refused outright (`/player`
 * returns 403 for every client, see docs/FINDINGS.md §11), so the practical fix is
 * to route all traffic through a residential/ISP proxy.
 *
 * Set `HTTPS_PROXY` (or `ALL_PROXY`) to enable. Both `Platform.shim.fetch` and the
 * global fetch are replaced, so libraries that reach for either one are covered.
 */

import { EnvHttpProxyAgent, setGlobalDispatcher } from 'undici';
import { Platform } from 'youtubei.js';

let installed = false;
let proxyUrl: string | null = null;

export function getProxyUrl(): string | null {
  return (
    process.env.HTTPS_PROXY ??
    process.env.https_proxy ??
    process.env.ALL_PROXY ??
    process.env.all_proxy ??
    null
  );
}

/**
 * Route all outbound traffic through the configured proxy.
 *
 * Idempotent, and a no-op when no proxy is configured — so callers can invoke it
 * unconditionally.
 */
export function installProxy(): void {
  if (installed) return;
  installed = true;

  const url = getProxyUrl();
  if (!url) return;
  proxyUrl = url;

  try {
    // undici 8's EnvHttpProxyAgent takes per-scheme overrides (and honours
    // NO_PROXY). Passing the value explicitly means ALL_PROXY works too.
    setGlobalDispatcher(new EnvHttpProxyAgent({ httpProxy: url, httpsProxy: url }));
    // youtubei.js uses Platform.shim.fetch for its own calls; point it at the
    // globally-dispatched fetch so it inherits the proxy.
    Platform.shim.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
      fetch(input as never, init as never)) as never;
    console.log('[proxy] outbound traffic routed through proxy');
  } catch (err) {
    console.warn('[proxy] failed to install:', String(err));
  }
}

export function proxyStatus(): { configured: boolean; url: string | null } {
  return { configured: !!proxyUrl, url: proxyUrl ? proxyUrl.replace(/\/\/[^@]*@/, '//***@') : null };
}
