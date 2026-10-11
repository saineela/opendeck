import { useCallback, useEffect, useState } from "react";
import { IconBug, IconChevronDown, IconRefresh } from "@tabler/icons-react";
import {
  getArtworkCacheStats,
  getCacheStats,
  type ArtworkCacheStats,
  type CacheStats,
} from "../../internal/cache";
import { useDownloaderState } from "../../plugins/official/downloader/downloaderStore";
import styles from "./DebugOverlay.module.css";

/**
 * Admin-only cache inspector (Settings → Admin → Debug).
 *
 * Answers "what is this page pulling from our own caches instead of Google?"
 * by reading the real state, not a log: it walks the live DOM for `<img>`
 * elements, classifies each as served by `/api/artwork` or straight from an
 * origin, and totals the server's JSON + image caches alongside the
 * browser-side stores.
 *
 * Deliberately read-only. Nothing here mutates cache state — the format
 * controls stay in Settings, where they are gated and confirmed.
 */

/** One image rendered on the page, and where its bytes actually came from. */
interface ArtworkItem {
  /** Origin URL (unwrapped from /api/artwork) or the direct src. */
  origin: string;
  /** True when our shared cache served it; false when it bypassed to origin. */
  cached: boolean;
  /** alt text when present, so the list reads like the page it came from. */
  label: string;
}

interface ArtworkScan {
  total: number;
  cached: number;
  direct: number;
  /** Distinct origin URLs behind the cached images — the real dedup win. */
  distinctOrigins: number;
  /** Largest image element currently rendered, by decoded area. */
  largest: { width: number; height: number } | null;
  /** Every image on the page, in DOM order — the actual inventory. */
  items: ArtworkItem[];
}

function scanArtwork(): ArtworkScan {
  const images = Array.from(document.querySelectorAll("img"));
  const origins = new Set<string>();
  const items: ArtworkItem[] = [];
  let cached = 0;
  let direct = 0;
  let largest: { width: number; height: number } | null = null;

  for (const image of images) {
    const src = image.currentSrc || image.src || "";
    if (!src) continue;

    const fromCache = src.includes("/api/artwork?");
    if (fromCache) {
      cached += 1;
      const raw = new URLSearchParams(src.split("?")[1] ?? "").get("url");
      if (raw) origins.add(raw);
      items.push({
        origin: raw ?? src,
        cached: true,
        label: image.alt?.trim() ?? "",
      });
    } else if (/^https?:/.test(src)) {
      // <img> elements pointing straight at an origin bypass the shared cache.
      direct += 1;
      items.push({ origin: src, cached: false, label: image.alt?.trim() ?? "" });
    }

    const area = image.naturalWidth * image.naturalHeight;
    if (area > 0 && (!largest || area > largest.width * largest.height)) {
      largest = { width: image.naturalWidth, height: image.naturalHeight };
    }
  }

  return {
    total: images.length,
    cached,
    direct,
    distinctOrigins: origins.size,
    largest,
    items,
  };
}

/** Keep the panel readable on grid pages with hundreds of thumbnails. */
const MAX_LISTED_ITEMS = 40;

/** Shorten a long CDN URL just enough to recognize the item. */
function shortUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const tail = decodeURIComponent(parsed.pathname).split("/").filter(Boolean).pop() ?? parsed.host;
    return tail.length > 52 ? `${tail.slice(0, 49)}…` : tail;
  } catch {
    return url.length > 52 ? `${url.slice(0, 49)}…` : url;
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

/** Browser-side stores the server cannot see. */
function browserStores() {
  const localKeys: string[] = [];
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (key) localKeys.push(key);
  }
  const localBytes = localKeys.reduce(
    (sum, key) => sum + key.length + (localStorage.getItem(key)?.length ?? 0),
    0,
  );
  return { keys: localKeys, approxBytes: localBytes * 2 };
}

interface DebugOverlayProps {
  onClose: () => void;
}

export function DebugOverlay({ onClose }: DebugOverlayProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [scan, setScan] = useState<ArtworkScan>(() => scanArtwork());
  const [jsonCache, setJsonCache] = useState<CacheStats | null>(null);
  const [artworkCache, setArtworkCache] = useState<ArtworkCacheStats | null>(null);
  const [stores] = useState(() => browserStores());
  const [refreshing, setRefreshing] = useState(false);
  const [lastRefreshed, setLastRefreshed] = useState(() => Date.now());
  const downloader = useDownloaderState();

  const refresh = useCallback(async () => {
    setRefreshing(true);
    // The DOM scan is synchronous so it reflects what is painted right now.
    setScan(scanArtwork());
    const [json, artwork] = await Promise.all([getCacheStats(), getArtworkCacheStats()]);
    setJsonCache(json);
    setArtworkCache(artwork);
    setLastRefreshed(Date.now());
    setRefreshing(false);
  }, []);

  // Re-scan on an interval so navigating between pages updates the panel
  // without the admin having to poke it.
  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => setScan(scanArtwork()), 2000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const offlineEntries = Object.values(downloader.entries);
  const offlineBytes = offlineEntries.reduce((sum, entry) => sum + entry.byteLength, 0);

  return (
    <aside className={styles.root} aria-label="Cache debug overlay">
      <header className={styles.header}>
        <span className={styles.title}>
          <IconBug size={16} aria-hidden="true" />
          Debug
        </span>
        <button
          className={styles.iconButton}
          type="button"
          aria-label={collapsed ? "Expand debug overlay" : "Collapse debug overlay"}
          onClick={() => setCollapsed((value) => !value)}
        >
          <IconChevronDown size={16} className={collapsed ? styles.chevronUp : ""} />
        </button>
        <button
          className={styles.iconButton}
          type="button"
          aria-label="Refresh cache stats"
          disabled={refreshing}
          onClick={() => void refresh()}
        >
          <IconRefresh size={16} />
        </button>
        <button className={styles.closeButton} type="button" onClick={onClose}>
          Dismiss
        </button>
      </header>

      {!collapsed && (
        <div className={styles.body}>
          <section className={styles.section}>
            <h3>This page</h3>
            <dl className={styles.stats}>
              <div>
                <dt>Images rendered</dt>
                <dd>{scan.total}</dd>
              </div>
              <div>
                <dt>From /api/artwork</dt>
                <dd className={scan.cached > 0 ? styles.good : undefined}>{scan.cached}</dd>
              </div>
              <div>
                <dt>Direct to origin</dt>
                <dd className={scan.direct > 0 ? styles.warn : undefined}>{scan.direct}</dd>
              </div>
              <div>
                <dt>Distinct sources</dt>
                <dd>{scan.distinctOrigins}</dd>
              </div>
              {scan.largest && (
                <div>
                  <dt>Largest decoded</dt>
                  <dd>
                    {scan.largest.width}×{scan.largest.height}
                  </dd>
                </div>
              )}
            </dl>
            <p className={styles.hint}>
              {scan.total === 0
                ? "No images on this page."
                : scan.direct === 0
                  ? "Every image on this page is served from our cache."
                  : `${scan.direct} image(s) bypass the shared cache and hit an origin directly.`}
            </p>

            {scan.items.length > 0 && (
              <details className={styles.details}>
                <summary>
                  Artwork on this page ({scan.cached} cached · {scan.direct} direct)
                </summary>
                <ul className={styles.itemList}>
                  {scan.items.slice(0, MAX_LISTED_ITEMS).map((item, index) => (
                    <li
                      className={item.cached ? styles.itemCached : styles.itemDirect}
                      key={`${item.origin}-${index}`}
                      title={item.origin}
                    >
                      <span className={styles.itemDot} aria-hidden="true" />
                      <span className={styles.itemLabel}>
                        {item.label || shortUrl(item.origin)}
                      </span>
                      <span className={styles.itemSource}>
                        {item.cached ? "our cache" : "direct"}
                      </span>
                    </li>
                  ))}
                  {scan.items.length > MAX_LISTED_ITEMS && (
                    <li className={styles.itemMore}>
                      …and {scan.items.length - MAX_LISTED_ITEMS} more
                    </li>
                  )}
                </ul>
              </details>
            )}
          </section>

          <section className={styles.section}>
            <h3>Server caches</h3>
            <dl className={styles.stats}>
              <div>
                <dt>Artwork</dt>
                <dd>
                  {artworkCache
                    ? `${formatBytes(artworkCache.usedBytes)} / ${formatBytes(artworkCache.maxBytes)}`
                    : "—"}
                </dd>
              </div>
              <div>
                <dt>Artwork entries</dt>
                <dd>{artworkCache?.entryCount ?? "—"}</dd>
              </div>
              <div>
                <dt>JSON cache</dt>
                <dd>
                  {jsonCache
                    ? `${formatBytes(jsonCache.usedBytes)} / ${formatBytes(jsonCache.maxBytes)}`
                    : "—"}
                </dd>
              </div>
              <div>
                <dt>JSON entries</dt>
                <dd>{jsonCache?.entryCount ?? "—"}</dd>
              </div>
            </dl>
          </section>

          <section className={styles.section}>
            <h3>This browser</h3>
            <dl className={styles.stats}>
              <div>
                <dt>localStorage keys</dt>
                <dd>{stores.keys.length}</dd>
              </div>
              <div>
                <dt>Approx. size</dt>
                <dd>{formatBytes(stores.approxBytes)}</dd>
              </div>
              <div>
                <dt>Offline audio</dt>
                <dd>{offlineEntries.length}</dd>
              </div>
              <div>
                <dt>Offline bytes</dt>
                <dd>{formatBytes(offlineBytes)}</dd>
              </div>
            </dl>
            <details className={styles.details}>
              <summary>localStorage keys</summary>
              <ul className={styles.keyList}>
                {stores.keys.map((key) => (
                  <li key={key}>
                    <code>{key}</code>
                  </li>
                ))}
              </ul>
            </details>
          </section>

          <footer className={styles.footer}>
            <span>Refreshed {new Date(lastRefreshed).toLocaleTimeString()}</span>
            <span>Read-only — use Settings to change caches.</span>
          </footer>
        </div>
      )}
    </aside>
  );
}
