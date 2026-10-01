/**
 * IPv6 egress rotation
 * ====================
 *
 * YouTube classifies egress by *address class*, not by a per-request counter:
 * `/youtubei/v1/player` refuses datacenter addresses while `/browse` answers from
 * the same IP. A single static IPv6 is treated the same way. What does work is
 * presenting a **different address from a routed /64**, which is the method
 * Invidious documents for escaping YouTube blocking ("Rotate your IPv6 address
 * for escaping YouTube blocking").
 *
 * Requirements and caveats, all of which matter:
 *
 *  - The host must have a **fully routed /64** (or larger). Most VPS providers do;
 *    AWS/GCP/Oracle typically require manual assignment and do *not* let you
 *    address arbitrarily within the prefix.
 *  - The address must be bound to the interface before use. Either run a rotator
 *    (`ip -6 addr add`) or rely on the whole /64 already being routed to the box —
 *    the latter is the common case and needs no root.
 *  - **One address per playback session.** The googlevideo media URL is signed and
 *    carries `ip=`; negotiating on one address and fetching media from another
 *    yields a silent media-only 403. So an address is pinned for the lifetime of a
 *    track, and rotation only happens between sessions or when a block is seen.
 *
 * When no /64 is configured this module is inert and the process egresses normally.
 */

import { Agent, Dispatcher, fetch as undiciFetch, setGlobalDispatcher } from 'undici';
import { AsyncLocalStorage } from 'node:async_hooks';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Addresses already known to be present, so we shell out at most once each. */
const present = new Set<string>();

interface Lease {
  address: string;
  dispatcher: Dispatcher;
  /** Sessions currently pinned to this address. */
  inUse: number;
  /** Incremented whenever this address produced a block. */
  failures: number;
  createdAt: number;
}

const leases = new Map<string, Lease>();
let prefix: string | null = null;
/** Prefix length of the configured range; used when adding an address. */
let prefixBits = 64;
let poolSize = 0;
let rotationMs = 6 * 60 * 60 * 1000; // re-lease an address every 6h by default

/* ------------------------------ helpers -------------------------------- */

/**
 * Expand an IPv6 prefix into concrete addresses.
 * Accepts a /64 (or shorter) written as `2001:db8:1234:5678::/64` and randomises
 * the lower 64 bits. A bare address without `/` is treated as a single address.
 */
export function configureIpv6Pool(raw: string | undefined, size: number, rotateHours: number): void {
  if (!raw) return;
  const [addr, bitsRaw] = raw.split('/');
  const bits = bitsRaw ? parseInt(bitsRaw, 10) : 128;
  if (!addr.includes(':')) return;

  const net = networkAddress(addr, bits);
  if (!net) {
    console.warn(`[egress] could not parse IPv6 prefix ${raw}; ignoring`);
    return;
  }

  prefix = net;
  prefixBits = bits;
  poolSize = bits >= 128 ? 1 : Math.max(1, size);
  rotationMs = Math.max(1, rotateHours) * 60 * 60 * 1000;
  console.log(
    `[egress] IPv6 pool: prefix=${prefix}/${prefixBits} ` +
      `addresses=${bits >= 128 ? 1 : `2^${128 - bits}`} rotate=${rotateHours}h`,
  );
}

/**
 * Mask an address down to its network prefix.
 *
 * Done by hand because Node has no IPv6 arithmetic and the length varies by
 * provider (GCP routes a /96 per NIC, AWS can delegate a /80, most VPS hosts
 * route a /64).
 */
function networkAddress(addr: string, bits: number): string | null {
  if (bits < 0 || bits > 128) return null;
  // Expand "::" into explicit zero groups so positional masking is well defined.
  const [head, tail] = addr.includes('::') ? addr.split('::') : [addr, null];
  const h = head ? head.split(':').filter(Boolean) : [];
  const t = tail ? tail.split(':').filter(Boolean) : [];
  const fill = 8 - h.length - t.length;
  if (fill < 0) return null;
  const groups = [...h, ...Array(tail !== null ? fill : 0).fill('0'), ...t];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/i.test(g))) return null;

  const full = groups.map((g) => g.padStart(4, '0')).join('');
  const kept = full.slice(0, bits).padEnd(32, '0');
  const out: string[] = [];
  for (let i = 0; i < 32; i += 4) out.push(kept.slice(i, i + 4).replace(/^0{1,3}(?=.)/, ''));
  return out.join(':').replace(/(^|:)0(:0)+(:|$)/, '::').replace(/^0::/, '::');
}

export function ipv6PoolStatus() {
  return {
    configured: !!prefix,
    prefix: prefix ? `${prefix}/${prefixBits}` : null,
    poolSize,
    leases: [...leases.values()].map((l) => ({
      address: l.address,
      inUse: l.inUse,
      failures: l.failures,
      ageMin: Math.round((Date.now() - l.createdAt) / 60000),
    })),
  };
}

/**
 * Make `address` usable as a source address.
 *
 * The kernel will not source from an address it does not have on the interface —
 * a routed prefix alone is not enough (verified: binding an unconfigured on-link
 * address produces no traffic at all). Adding it needs CAP_NET_ADMIN, so this
 * shells out to `ip -6 addr add` and degrades to a clear warning when it lacks
 * permission. On a host where the whole prefix is already configured none of this
 * runs.
 */
async function ensureAddressPresent(address: string): Promise<boolean> {
  if (present.has(address)) return true;
  if (process.platform !== 'linux') {
    present.add(address); // nothing to do elsewhere; let the bind attempt decide
    return true;
  }
  const iface = process.env.EGRESS_IPV6_IFACE || (await defaultInterface());
  if (!iface) {
    console.warn('[egress] could not determine the outbound interface; set EGRESS_IPV6_IFACE');
    return false;
  }
  // The kernel rejects /128 for an on-link address ("inet6 prefix is expected"),
  // so bind it with the length of the range the provider routed to us.
  for (const args of [
    ['-6', 'addr', 'add', `${address}/${prefixBits}`, 'dev', iface, 'preferred_lft', '0', 'valid_lft', '3600'],
  ]) {
    try {
      await run('ip', args, { timeout: 5000 });
      present.add(address);
      return true;
    } catch (err) {
      const msg = String((err as { stderr?: string }).stderr ?? (err as Error).message).trim();
      if (/exists/i.test(msg)) {
        present.add(address);
        return true;
      }
      console.warn(
        `[egress] cannot add ${address} to ${iface} (${msg.split('\n')[0].slice(0, 80)}). ` +
          'Rotation needs CAP_NET_ADMIN; grant it or pre-configure the prefix.',
      );
      return false;
    }
  }
  return false;
}

async function defaultInterface(): Promise<string | null> {
  try {
    const { stdout } = await run('ip', ['-6', 'route', 'show', 'default'], { timeout: 4000 });
    const m = stdout.match(/dev\s+(\S+)/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/**
 * Random address inside the configured prefix.
 *
 * The compression matters: a prefix like `2406:7400:c4:7b7b::` already contains a
 * `::`, which stands for *at least one* zero group, so appending four more groups
 * would yield nine — invalid IPv6, and the kernel rejects it with "inet6 prefix is
 * expected". Appending only three keeps the total at eight.
 */
function randomAddress(): string {
  if (!prefix) throw new Error('no IPv6 prefix configured');
  // A /128 is a single address: there is nothing to randomise.
  if (prefixBits >= 128) return prefix;

  // Work in bits. Pad the prefix out to its full width, randomise every remaining
  // bit, then re-compress. Doing it this way keeps the address inside the routed
  // range AND uses all available entropy — building it group-by-group instead
  // would give a /64 only 16 bits of choice.
  const expanded = expandGroups(prefix);
  if (!expanded) throw new Error(`could not expand prefix ${prefix}`);
  // Bits -> hex characters: 4 bits per character. Mixing the two units silently
  // produced the bare network address with no random part at all.
  const fixedChars = prefixBits / 4;
  const randomChars = (128 - prefixBits) / 4;
  const fixed = expanded.join('').slice(0, fixedChars);
  let tail = '';
  for (let i = 0; i < randomChars; i += 4) {
    const take = Math.min(4, randomChars - i);
    const value = Math.floor(Math.random() * 16 ** take);
    tail += value.toString(16).padStart(take, '0');
  }
  const address = compressGroups(fixed.padEnd(fixedChars, '0') + tail);
  if (!isValidIpv6(address)) {
    // Never hand out something the kernel will reject.
    throw new Error(`generated invalid IPv6 address from prefix ${prefix}: ${address}`);
  }
  return address;
}

/** "2406:db8::" -> ["2406","0db8","0000",…] (always eight groups). */
function expandGroups(address: string): string[] | null {
  const [head, tail] = address.includes('::') ? address.split('::') : [address, null];
  const h = head ? head.split(':').filter(Boolean) : [];
  const t = tail ? tail.split(':').filter(Boolean) : [];
  const fill = 8 - h.length - t.length;
  if (fill < 0) return null;
  const groups = [...h, ...Array(tail !== null ? fill : 0).fill('0'), ...t];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/i.test(g))) return null;
  return groups.map((g) => g.padStart(4, '0').toLowerCase());
}

/** Eight 4-hex groups -> the shortest valid textual form. */
function compressGroups(hex32: string): string {
  const groups: string[] = [];
  for (let i = 0; i < 32; i += 4) groups.push(hex32.slice(i, i + 4));
  // Find the longest run of zero groups to replace with "::".
  let bestStart = -1;
  let bestLen = 0;
  let runStart = -1;
  for (let i = 0; i <= groups.length; i++) {
    if (i < groups.length && groups[i] === '0000') {
      if (runStart === -1) runStart = i;
    } else if (runStart !== -1) {
      const len = i - runStart;
      if (len > bestLen) {
        bestLen = len;
        bestStart = runStart;
      }
      runStart = -1;
    }
  }
  if (bestLen < 2) return groups.map((g) => g.replace(/^0{1,3}(?=.)/, '')).join(':');
  const head = groups.slice(0, bestStart).map((g) => g.replace(/^0{1,3}(?=.)/, '')).join(':');
  const tail = groups.slice(bestStart + bestLen).map((g) => g.replace(/^0{1,3}(?=.)/, '')).join(':');
  return `${head}::${tail}`;
}

/** Structural validity check (no dependencies). */
function isValidIpv6(address: string): boolean {
  if (!address.includes(':')) return false;
  if ((address.match(/::/g) ?? []).length > 1) return false;
  const [head, tail] = address.includes('::')
    ? address.split('::')
    : [address, null];
  const count = (part: string): number => (part ? part.split(':').filter(Boolean).length : 0);
  const groups = count(head) + count(tail ?? '');
  const hasCompression = tail !== null;
  if (groups > 8) return false;
  if (!hasCompression && groups !== 8) return false;
  if (hasCompression && groups >= 8) return false; // :: must stand for >= 1 group
  return address
    .replace('::', ':')
    .split(':')
    .filter(Boolean)
    .every((g) => /^[0-9a-f]{1,4}$/i.test(g));
}

function makeDispatcher(address: string): Dispatcher {
  return new Agent({
    // localAddress is a *connector* option, not a top-level Agent option.
    connect: { localAddress: address, timeout: 20_000 },
    keepAliveTimeout: 30_000,
    keepAliveMaxTimeout: 60_000,
  });
}

/* ------------------------------- leasing -------------------------------- */

/**
 * Lease an address for a playback session.
 *
 * Prefers an address that is not currently in use and has no recorded failures,
 * so concurrent tracks do not share an egress address (which would make one
 * track's block affect another).
 */
export function leaseAddress(): Lease | null {
  if (!prefix) return null;
  const now = Date.now();
  for (const lease of leases.values()) {
    if (lease.inUse === 0 && lease.failures === 0 && now - lease.createdAt < rotationMs) {
      lease.inUse++;
      return lease;
    }
  }
  // Retire expired or repeatedly-failing addresses, then mint a fresh one.
  if (leases.size >= Math.max(poolSize, 2)) {
    const stale = [...leases.values()]
      .filter((l) => l.inUse === 0)
      .sort((a, b) => b.failures - a.failures || a.createdAt - b.createdAt)[0];
    if (stale) {
      void stale.dispatcher.close().catch(() => {});
      leases.delete(stale.address);
    }
  }
  const address = randomAddress();
  const lease: Lease = { address, dispatcher: makeDispatcher(address), inUse: 1, failures: 0, createdAt: now };
  leases.set(address, lease);
  // Fire and forget: the caller's first request will simply retry via the default
  // route if the address is not usable yet.
  void ensureAddressPresent(address);
  return lease;
}

export function releaseAddress(lease: Lease | null): void {
  if (!lease) return;
  lease.inUse = Math.max(0, lease.inUse - 1);
}

/** Report that an address was refused, so it is not reused. */
export function markAddressBlocked(lease: Lease | null): void {
  if (!lease) return;
  lease.failures++;
  console.warn(`[egress] address ${lease.address} refused (failures=${lease.failures}); rotating`);
}

/** Run `fn` with a pinned address, releasing it afterwards. */
export async function withAddress<T>(fn: (lease: Lease | null) => Promise<T>): Promise<T> {
  const lease = leaseAddress();
  try {
    return await fn(lease);
  } finally {
    releaseAddress(lease);
  }
}

/* --------------------------- request routing ---------------------------- */

/**
 * Routes each connection to the source address of whichever playback session is
 * currently executing.
 *
 * A single global dispatcher cannot express "address per concurrent session", and
 * all requests in a session must share one address. AsyncLocalStorage gives each
 * session its own context without threading parameters through youtubei.js,
 * googlevideo and BotGuard.
 */
class RoutingDispatcher extends Dispatcher {
  constructor(private readonly store: AsyncLocalStorage<Lease>) {
    super();
  }

  dispatch(opts: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {
    const lease = this.store.getStore();
    // Fall back to the default global agent when no lease is active.
    const target = lease ? lease.dispatcher : defaultDispatcher;
    return target.dispatch(opts, handler);
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  destroy(): Promise<void> {
    return Promise.resolve();
  }
}

const leaseStore = new AsyncLocalStorage<Lease>();
let defaultDispatcher: Dispatcher = new Agent();
let routingInstalled = false;

/**
 * Install the routing dispatcher. No-op unless a pool is configured.
 *
 * This also swaps the *global* fetch for undici's own implementation. Node's
 * bundled fetch rejects a standalone undici Agent with "invalid onRequestStart
 * method" (a bundled-version clash), so leaving it in place would silently bypass
 * the source address — and an unbound address does not error, it quietly falls
 * back to the interface's primary address. Every dependency (youtubei.js,
 * googlevideo, BotGuard) calls the global fetch, so replacing it is what makes
 * rotation actually take effect.
 */
export function installAddressRouting(): void {
  if (routingInstalled || !prefix) return;
  routingInstalled = true;
  setGlobalDispatcher(new RoutingDispatcher(leaseStore));
  Object.defineProperty(globalThis, 'fetch', {
    value: ((input: RequestInfo | URL, init?: RequestInit) =>
      undiciFetch(input as never, init as never)) as unknown as typeof fetch,
    writable: true,
    configurable: true,
  });
  console.log('[egress] per-session IPv6 routing active (global fetch replaced)');
}

/** Run a playback session inside its own egress address. */
export function runWithAddress<T>(fn: () => Promise<T>): Promise<T> {
  if (!prefix) return fn();
  const lease = leaseAddress();
  if (!lease) return fn();
  return leaseStore.run(lease, async () => {
    try {
      return await fn();
    } catch (err) {
      const msg = String((err as Error)?.message ?? err);
      // A refusal here means this address is burned; do not reuse it.
      if (/LOGIN_REQUIRED|403|UNPLAYABLE/i.test(msg)) markAddressBlocked(lease);
      throw err;
    } finally {
      releaseAddress(lease);
    }
  });
}

/**
 * Point the global dispatcher at a lease.
 *
 * Everything outbound must leave from the same address during a session —
 * youtubei.js uses `Platform.shim.fetch`, and googlevideo/BotGuard use the global
 * fetch — so a single global dispatcher swap is the simplest way to guarantee
 * that. Callers restore the previous dispatcher when the session ends.
 */
export function activateLease(lease: Lease | null): Dispatcher | null {
  if (!lease) return null;
  setGlobalDispatcher(lease.dispatcher);
  return lease.dispatcher;
}

/** Periodic maintenance: drop idle, failed or expired addresses. */
export function reapLeases(): void {
  const now = Date.now();
  for (const [address, lease] of leases) {
    const expired = now - lease.createdAt > rotationMs;
    if (lease.inUse === 0 && (expired || lease.failures > 2)) {
      void lease.dispatcher.close().catch(() => {});
      leases.delete(address);
    }
  }
}
