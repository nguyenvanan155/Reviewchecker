/**
 * proxyManager.js
 * Loads proxies from proxies.json, tracks failures, and provides
 * Playwright-compatible proxy config objects.
 * Supports pool-based selection: random or round-robin among a user-chosen subset.
 */

const fs = require('fs');
const path = require('path');

const PROXIES_PATH = path.join(__dirname, 'proxies.json');

class ProxyManager {
  constructor() {
    this.proxies = [];
    this.failedProxies = new Set();
    this._rrIndex = 0; // 
    this.load();
  }

  load() {
    try {
      let raw = fs.readFileSync(PROXIES_PATH, 'utf-8');
      // Strip UTF-8 BOM (common when files are saved on Windows with BOM)
      raw = raw.replace(/^\uFEFF/, '');
      // Normalize Windows CRLF -> LF
      raw = raw.replace(/\r\n/g, '\n');
      this.proxies = JSON.parse(raw);
      console.log(`[ProxyManager] Loaded ${this.proxies.length} proxies`);
    } catch (err) {
      console.error(`[ProxyManager] Failed to load proxies.json: ${err.message}`);
      console.error(`[ProxyManager] Tip: Validate your proxies.json at https://jsonlint.com/`);
      this.proxies = [];
    }
  }


  reload() {
    this.failedProxies.clear();
    this._rrIndex = 0;
    this.load();
  }

  /** Return all proxies as {id, label, url} */
  list() {
    return this.proxies;
  }

  /**
   * Get a proxy from a specific pool of IDs.
   * @param {string[]} proxyIds  IDs the user selected. Empty = no proxy.
   * @param {string}   rotation  'random' | 'roundrobin'
   * @param {string[]} excludeIds  IDs to skip (already tried in retry)
   * @returns {{ server, _proxyId, username?, password? } | undefined}
   */
  getFromPool(proxyIds, rotation = 'random', excludeIds = []) {
    if (!proxyIds || proxyIds.length === 0) return undefined;

    const pool = this.proxies.filter(
      (p) => proxyIds.includes(p.id) && !this.failedProxies.has(p.id) && !excludeIds.includes(p.id)
    );
    if (pool.length === 0) return undefined;

    let chosen;
    if (rotation === 'roundrobin') {
      this._rrIndex = this._rrIndex % pool.length;
      chosen = pool[this._rrIndex];
      this._rrIndex++;
    } else {
      chosen = pool[Math.floor(Math.random() * pool.length)];
    }

    return this._buildConfig(chosen);
  }

  /**
   * Get any proxy from the pool OTHER than currentId (for retry).
   * @param {string[]} proxyIds
   * @param {string}   currentId
   * @returns {{ server, _proxyId } | undefined}
   */
  getAlternateFromPool(proxyIds, currentId) {
    const pool = this.proxies.filter(
      (p) => proxyIds.includes(p.id) && p.id !== currentId && !this.failedProxies.has(p.id)
    );
    if (pool.length === 0) return undefined;
    const chosen = pool[Math.floor(Math.random() * pool.length)];
    return this._buildConfig(chosen);
  }

  markFailed(proxyId) {
    if (proxyId) {
      this.failedProxies.add(proxyId);
      console.warn(`[ProxyManager] Marked proxy as failed: ${proxyId}`);
    }
  }

  _buildConfig(proxy) {
    const url = new URL(proxy.url);
    const config = { server: `${url.protocol}//${url.hostname}:${url.port}`, _proxyId: proxy.id };
    if (url.username) config.username = decodeURIComponent(url.username);
    if (url.password) config.password = decodeURIComponent(url.password);
    return config;
  }
}

module.exports = new ProxyManager();
