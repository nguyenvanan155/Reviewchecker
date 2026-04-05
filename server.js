/**
 * server.js
 * Express HTTP + WebSocket server for the Google Maps Review Checker.
 */

const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const fs = require('fs');

const sheetsClient = require('./sheetsClient');
const proxyManager = require('./proxyManager');
const { checkUrlWithRetry } = require('./checker');
const Queue = require('./queue');

const PORT = parseInt(process.env.PORT || '3000', 10);
const SETTINGS_PATH = path.join(__dirname, 'settings.json');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// ─── State ────────────────────────────────────────────────────────────────────

const jobQueue = new Queue();
let activeJob = false;
let resultCache = {}; // url -> status (cleared on new job start)
let sessionLogs = [];

// ─── WebSocket broadcast ──────────────────────────────────────────────────────

function broadcast(type, payload) {
  const msg = JSON.stringify({ type, ...payload });
  wss.clients.forEach((ws) => {
    if (ws.readyState === 1) ws.send(msg);
  });
}

function sendLog(level, message) {
  const entry = { time: new Date().toISOString(), level, message };
  sessionLogs.push(entry);
  broadcast('log', entry);
}

// ─── Settings persistence ─────────────────────────────────────────────────────

function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_PATH)) {
      return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8'));
    }
  } catch (_) {}
  return {};
}

function saveSettings(data) {
  try {
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(data, null, 2));
  } catch (_) {}
}

// ─── REST API endpoints ───────────────────────────────────────────────────────

// List sheet tabs
app.get('/api/sheets/:sheetId/tabs', async (req, res) => {
  try {
    const tabs = await sheetsClient.listTabs(req.params.sheetId);
    res.json({ ok: true, tabs });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// Auto-detect columns
app.get('/api/sheets/:sheetId/detect', async (req, res) => {
  const { tab } = req.query;
  if (!tab) return res.status(400).json({ ok: false, error: 'tab is required' });
  try {
    const result = await sheetsClient.autoDetectColumns(req.params.sheetId, tab);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// List proxies (no reload — proxies load once at startup)
app.get('/api/proxies', (req, res) => {
  res.json({ ok: true, proxies: proxyManager.list() });
});

// Explicitly reload proxies.json (called by the ↺ button in the UI)
app.post('/api/proxies/reload', (req, res) => {
  proxyManager.reload();
  res.json({ ok: true, proxies: proxyManager.list() });
});

// Get / Set server-side settings
app.get('/api/settings', (req, res) => {
  res.json({ ok: true, settings: loadSettings() });
});

app.post('/api/settings', (req, res) => {
  saveSettings(req.body);
  res.json({ ok: true });
});

// Get session logs
app.get('/api/logs', (req, res) => {
  res.json({ ok: true, logs: sessionLogs });
});

// Export logs as plain text
app.get('/api/logs/export', (req, res) => {
  const text = sessionLogs
    .map((l) => `[${l.time}] [${l.level.toUpperCase()}] ${l.message}`)
    .join('\n');
  res.setHeader('Content-Disposition', 'attachment; filename="check_logs.txt"');
  res.setHeader('Content-Type', 'text/plain');
  res.send(text);
});

// Clear result cache
app.post('/api/cache/clear', (req, res) => {
  resultCache = {};
  res.json({ ok: true });
});

// Stop current job
app.post('/api/stop', (req, res) => {
  if (activeJob) {
    jobQueue.stop();
    sendLog('info', '🛑 Stop requested by user.');
    broadcast('status', { running: false, stopped: true });
  }
  res.json({ ok: true });
});

// Pause current job
app.post('/api/pause', (req, res) => {
  if (activeJob && !jobQueue.isPaused()) {
    jobQueue.pause();
    sendLog('info', '⏸️ Job paused.');
    broadcast('status', { paused: true });
  }
  res.json({ ok: true });
});

// Resume current job
app.post('/api/resume', (req, res) => {
  if (activeJob && jobQueue.isPaused()) {
    jobQueue.resume();
    sendLog('info', '▶️ Job resumed.');
    broadcast('status', { paused: false });
  }
  res.json({ ok: true });
});

// Start a check job
app.post('/api/check', async (req, res) => {
  if (activeJob) {
    return res.status(409).json({ ok: false, error: 'A job is already running. Stop it first.' });
  }

  const {
    sheetId,
    tab,             // 'ALL' or a specific tab name
    linkCol,         // e.g. 'A'
    statusCol,       // e.g. 'B'
    proxyIds = [],   // array of selected proxy IDs (empty = no proxy)
    proxyRotation = 'random', // 'random' | 'roundrobin'
    concurrency = 3,
    skipCached = true,
  } = req.body;

  if (!sheetId || !linkCol || !statusCol) {
    return res.status(400).json({ ok: false, error: 'sheetId, linkCol, and statusCol are required.' });
  }

  // Respond immediately; job runs in background
  res.json({ ok: true, message: 'Job started.' });

  activeJob = true;
  sessionLogs = [];
  resultCache = skipCached ? resultCache : {};

  try {
    // Determine which tabs to process
    let tabs = [];
    if (tab === 'ALL') {
      const allTabs = await sheetsClient.listTabs(sheetId);
      tabs = allTabs.map((t) => t.title);
    } else {
      tabs = [tab];
    }

    sendLog('info', `📋 Processing ${tabs.length} tab(s): ${tabs.join(', ')}`);
    broadcast('status', { running: true, paused: false, total: 0, done: 0 });

    let grandTotal = 0;
    const allWorkItems = [];

    for (const tabName of tabs) {
      const rows = await sheetsClient.readColumn(sheetId, tabName, linkCol);
      const validRows = rows.filter((r) => r.value && r.value.startsWith('http'));
      sendLog('info', `📄 Tab "${tabName}": found ${validRows.length} links`);
      validRows.forEach((r) => allWorkItems.push({ tabName, row: r.row, url: r.value }));
      grandTotal += validRows.length;
    }

    broadcast('status', { running: true, total: grandTotal, done: 0 });
    const proxyDesc = proxyIds.length
      ? `${proxyIds.length} proxies [${proxyRotation}]`
      : 'No proxy';
    sendLog('info', `🚀 Starting check on ${grandTotal} links | concurrency=${concurrency} | proxy: ${proxyDesc}`);

    let doneCount = 0;
    // Batch writes: collect per-tab updates
    const pendingWrites = {}; // tabName -> [{row, value}]

    await jobQueue.run(
      allWorkItems,
      concurrency,
      async (item) => {
        const { tabName, row, url } = item;
        broadcast('current', { url, tabName, row });

        // Cache check
        if (skipCached && resultCache[url]) {
          const cached = resultCache[url];
          sendLog('info', `💾 Cached: ${url} → ${cached}`);
          if (!pendingWrites[tabName]) pendingWrites[tabName] = [];
          pendingWrites[tabName].push({ row, value: cached });
          return { status: cached, cached: true };
        }

        const status = await checkUrlWithRetry(url, proxyIds, proxyRotation, 2, (msg) =>
          sendLog('info', msg)
        );

        resultCache[url] = status;
        if (!pendingWrites[tabName]) pendingWrites[tabName] = [];
        pendingWrites[tabName].push({ row, value: status });

        // Write in small batches (every 5 results) to avoid rate limits
        if (pendingWrites[tabName].length >= 5) {
          const batch = pendingWrites[tabName].splice(0);
          try {
            await sheetsClient.writeCells(sheetId, tabName, statusCol, batch);
            sendLog('info', `💾 Wrote ${batch.length} results to Sheet "${tabName}"`);
          } catch (e) {
            sendLog('error', `❌ Sheet write error: ${e.message}`);
            // Re-queue failed writes
            pendingWrites[tabName].unshift(...batch);
          }
        }

        return { status };
      },
      (done, total, item, result) => {
        doneCount = done;
        const pct = Math.round((done / total) * 100);
        const { status } = result;
        const level = status === '✅ Public' ? 'success' : status === '❌ Dead' ? 'dead' : 'warn';
        sendLog(level, `[${done}/${total}] ${status} — ${item.url}`);
        broadcast('progress', { done, total, pct });
      }
    );

    // Flush remaining writes
    for (const [tabName, updates] of Object.entries(pendingWrites)) {
      if (updates.length > 0) {
        try {
          await sheetsClient.writeCells(sheetId, tabName, statusCol, updates);
          sendLog('info', `💾 Final flush: wrote ${updates.length} results to "${tabName}"`);
        } catch (e) {
          sendLog('error', `❌ Final write error: ${e.message}`);
        }
      }
    }

    const stopped = jobQueue.isStopped();
    sendLog('info', stopped ? '🛑 Job stopped by user.' : '✅ All done!');
    broadcast('status', { running: false, done: doneCount, total: grandTotal, finished: !stopped, stopped });
  } catch (err) {
    sendLog('error', `❌ Fatal error: ${err.message}`);
    broadcast('status', { running: false, error: err.message });
  } finally {
    activeJob = false;
  }
});

// WebSocket connection handler
wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'connected', message: 'Connected to server.' }));
  // Send recent logs on connect
  sessionLogs.slice(-50).forEach((log) => {
    ws.send(JSON.stringify({ type: 'log', ...log }));
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`\n🗺️  Google Maps Review Checker`);
  console.log(`   Server: http://localhost:${PORT}`);
  console.log(`   Press Ctrl+C to stop.\n`);
});
