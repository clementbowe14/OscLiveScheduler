/* ═══════════════════════════════════════════════════════════════════════════
   OSC Live Scheduler — Frontend Application Logic
   
   Dual-mode fetching:
     1. Tries the local API first (/api/schedule) — fast, no CORS issues
     2. Falls back to direct Socket.IO to Podium if no backend is available
   
   In production, /api/schedule is expected to be served by the Netlify
   Function because browsers cannot send the x-user WebSocket header Podium
   expects.
   ═══════════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  // ─── Config ──────────────────────────────────────────────────────────────
  const PODIUM_URL = 'https://live.podiumsystem.mx';
  const EVENT_ID = 215;
  const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
  const API_TIMEOUT_MS = 20000;
  const API_SLOW_WARNING_MS = 8000;
  const SOCKET_TIMEOUT_MS = 30000;
  const MAX_RETRIES = 2;

  const MATCH_KEYWORDS = [
    'salsa ninja',
    'ninja dance',
    'academia salsa ninja',
  ];

  // ─── DOM Elements ────────────────────────────────────────────────────────
  const statusText = document.getElementById('statusText');
  const pulseDot = document.querySelector('.pulse-dot');
  const eventNameText = document.getElementById('eventNameText');
  const lastUpdateText = document.getElementById('lastUpdateText');
  const nextRefreshText = document.getElementById('nextRefreshText');
  const refreshBtn = document.getElementById('refreshBtn');
  const totalEntries = document.getElementById('totalEntries');
  const ninjaEntries = document.getElementById('ninjaEntries');
  const pollInterval = document.getElementById('pollInterval');
  const loadingState = document.getElementById('loadingState');
  const emptyState = document.getElementById('emptyState');
  const emptyStateIcon = emptyState.querySelector('.empty-icon');
  const emptyStateTitle = emptyState.querySelector('h3');
  const emptyStateMessage = emptyState.querySelector('p');
  const loadingStateMessage = loadingState.querySelector('p');
  const scheduleTable = document.getElementById('scheduleTable');
  const scheduleBody = document.getElementById('scheduleBody');

  // ─── State ───────────────────────────────────────────────────────────────
  let countdownInterval = null;
  let nextRefreshTime = null;
  let pollTimer = null;
  let isFetching = false;
  let lastFetchDate = null;
  let useLocalApi = null; // null = unknown, true/false = detected

  // ─── Helpers ─────────────────────────────────────────────────────────────
  function formatTime(hora) {
    if (!hora) return null;
    const parts = hora.split(':');
    if (parts.length < 2) return hora;
    let h = parseInt(parts[0], 10);
    const m = parts[1];
    const s = parts[2] || '00';
    const ampm = h >= 12 ? 'PM' : 'AM';
    h = h > 12 ? h - 12 : h;
    h = h === 0 ? 12 : h;
    return `${h}:${m}:${s} ${ampm}`;
  }

  function parseScheduleTime(hora) {
    const match = String(hora || '').match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?/);
    if (!match) return Number.POSITIVE_INFINITY;
    const hours = parseInt(match[1], 10);
    const minutes = parseInt(match[2], 10);
    const seconds = parseInt(match[3] || '0', 10);
    return (hours * 60 * 60) + (minutes * 60) + seconds;
  }

  function parseScheduleDate(fecha) {
    if (!fecha) return Number.POSITIVE_INFINITY;

    const normalized = String(fecha).trim();
    const isoMatch = normalized.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (isoMatch) {
      return Date.UTC(
        parseInt(isoMatch[1], 10),
        parseInt(isoMatch[2], 10) - 1,
        parseInt(isoMatch[3], 10)
      );
    }

    const slashMatch = normalized.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (slashMatch) {
      const first = parseInt(slashMatch[1], 10);
      const second = parseInt(slashMatch[2], 10);
      const year = parseInt(slashMatch[3], 10);
      const month = first > 12 ? second : first;
      const day = first > 12 ? first : second;
      return Date.UTC(year, month - 1, day);
    }

    const parsed = Date.parse(normalized);
    return Number.isNaN(parsed) ? Number.POSITIVE_INFINITY : parsed;
  }

  function compareScheduleEntries(a, b) {
    const dateDiff = parseScheduleDate(a.fecha) - parseScheduleDate(b.fecha);
    if (dateDiff !== 0) return dateDiff;

    const timeDiff = parseScheduleTime(a.hora) - parseScheduleTime(b.hora);
    if (timeDiff !== 0) return timeDiff;

    return (a.turno || Number.POSITIVE_INFINITY) - (b.turno || Number.POSITIVE_INFINITY);
  }

  function timeAgo(date) {
    if (!date) return '—';
    const diff = Date.now() - date.getTime();
    const secs = Math.floor(diff / 1000);
    if (secs < 5) return 'just now';
    if (secs < 60) return `${secs}s ago`;
    const mins = Math.floor(secs / 60);
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    return `${hrs}h ${mins % 60}m ago`;
  }

  function getStatusInfo(estatus) {
    const s = (estatus || '').toUpperCase();
    if (s === 'PRESENTANDO') return { label: '🎭 Performing', cls: 'performing' };
    if (s === 'ACTIVO') return { label: '⏳ Waiting', cls: 'waiting' };
    if (s === 'FINALIZADO') return { label: '✓ Finished', cls: 'finished' };
    return { label: estatus || '—', cls: 'unknown' };
  }

  function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function setConnectionStatus(status) {
    pulseDot.classList.remove('error', 'loading');
    if (status === 'live') {
      statusText.textContent = 'LIVE';
    } else if (status === 'error') {
      statusText.textContent = 'OFFLINE';
      pulseDot.classList.add('error');
    } else if (status === 'retrying') {
      statusText.textContent = 'RETRYING';
      pulseDot.classList.add('loading');
    } else {
      statusText.textContent = 'CONNECTING';
      pulseDot.classList.add('loading');
    }
  }

  function isLocalHost() {
    return ['localhost', '127.0.0.1', ''].includes(window.location.hostname);
  }

  function shouldAttemptBrowserSocketFallback() {
    return isLocalHost() || window.location.protocol === 'file:';
  }

  function serializeLogArg(arg) {
    if (arg instanceof Error) {
      return { name: arg.name, message: arg.message, stack: arg.stack };
    }

    if (arg && typeof arg === 'object') {
      try {
        return JSON.parse(JSON.stringify(arg));
      } catch (jsonErr) {
        return String(arg);
      }
    }

    return arg;
  }

  function recordLog(level, msg, args) {
    const entry = {
      at: new Date().toISOString(),
      level,
      message: msg,
      details: args.map(serializeLogArg),
    };

    window.OSC_LOGS = window.OSC_LOGS || [];
    window.OSC_LOGS.push(entry);
    if (window.OSC_LOGS.length > 100) window.OSC_LOGS.shift();
    window.oscDiagnostics = () => ({
      mode: useLocalApi === null ? 'detecting' : useLocalApi ? 'api' : 'socket-fallback',
      lastFetchDate: lastFetchDate ? lastFetchDate.toISOString() : null,
      currentUrl: window.location.href,
      logs: window.OSC_LOGS,
    });
  }

  function log(msg, ...args) {
    const ts = new Date().toLocaleTimeString();
    recordLog('info', msg, args);
    console.log(`[OSC ${ts}] ${msg}`, ...args);
  }

  function logWarn(msg, ...args) {
    const ts = new Date().toLocaleTimeString();
    recordLog('warn', msg, args);
    console.warn(`[OSC ${ts}] ${msg}`, ...args);
  }

  function summarizeApiData(data) {
    return {
      eventName: data.eventName || null,
      lastFetchTime: data.lastFetchTime || null,
      connectionStatus: data.connectionStatus || null,
      totalEventEntries: data.totalEventEntries ?? null,
      filteredCount: data.filteredCount ?? null,
      lastError: data.lastError || null,
      source: data.source || null,
    };
  }

  function showLoadingState(message = 'Connecting to Podium System...') {
    loadingStateMessage.textContent = message;
    loadingState.style.display = 'flex';
    emptyState.style.display = 'none';
    scheduleTable.style.display = 'none';
  }

  function showMessageState({ icon, title, message }) {
    emptyStateIcon.textContent = icon;
    emptyStateTitle.textContent = title;
    emptyStateMessage.textContent = message;
    loadingState.style.display = 'none';
    emptyState.style.display = 'flex';
    scheduleTable.style.display = 'none';
  }

  function showNoPerformancesState() {
    showMessageState({
      icon: '🔍',
      title: 'No Performances Found',
      message: 'No choreographies from Academia Salsa Ninja Dance Academy are currently listed. The schedule updates every 5 minutes — check back soon!',
    });
  }

  function showReadErrorState(reason) {
    showMessageState({
      icon: '!',
      title: 'Live Schedule Unavailable',
      message: `${reason} Open the browser console and run window.oscDiagnostics() for details.`,
    });
  }

  // ─── Countdown Timer ────────────────────────────────────────────────────
  function startCountdown() {
    nextRefreshTime = Date.now() + POLL_INTERVAL_MS;
    if (countdownInterval) clearInterval(countdownInterval);
    countdownInterval = setInterval(() => {
      const remaining = Math.max(0, nextRefreshTime - Date.now());
      const mins = Math.floor(remaining / 60000);
      const secs = Math.floor((remaining % 60000) / 1000);
      nextRefreshText.textContent = `${mins}:${secs.toString().padStart(2, '0')}`;
      if (remaining <= 0) {
        nextRefreshText.textContent = 'refreshing…';
      }
    }, 1000);
  }

  // Keep last-update chip fresh
  setInterval(() => {
    if (lastFetchDate) {
      lastUpdateText.textContent = timeAgo(lastFetchDate);
    }
  }, 5000);

  // ═══════════════════════════════════════════════════════════════════════════
  // MODE 1: Local API fetch (when Node.js backend is running)
  // ═══════════════════════════════════════════════════════════════════════════
  async function fetchFromLocalApi() {
    log(`Trying local API at /api/schedule (${API_TIMEOUT_MS}ms timeout)...`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
    const slowTimer = setTimeout(() => {
      showLoadingState('Still waiting for the Podium read...');
      logWarn(`Local API is still pending after ${API_SLOW_WARNING_MS}ms`, {
        apiPath: '/api/schedule',
        timeoutMs: API_TIMEOUT_MS,
      });
    }, API_SLOW_WARNING_MS);

    try {
      const res = await fetch('/api/schedule', { signal: controller.signal });
      clearTimeout(timer);
      clearTimeout(slowTimer);
      const responseText = await res.text();
      let data = null;

      try {
        data = responseText ? JSON.parse(responseText) : {};
      } catch (jsonErr) {
        throw new Error(`HTTP ${res.status}; response was not JSON: ${responseText.slice(0, 160)}`);
      }

      if (!res.ok) {
        const message = data.error || data.message || `HTTP ${res.status}`;
        logWarn('Local API returned an error payload:', {
          status: res.status,
          statusText: res.statusText,
          summary: summarizeApiData(data),
        });
        throw new Error(message);
      }

      if (!data.lastFetchTime) throw new Error('No data from backend yet');

      lastFetchDate = new Date();
      renderSchedule(data);
      setConnectionStatus('live');
      log(`Local API read succeeded: ${data.totalEventEntries} total, ${data.filteredCount} Salsa Ninja matches`, summarizeApiData(data));
      return true;
    } catch (err) {
      clearTimeout(timer);
      clearTimeout(slowTimer);
      const reason = err.name === 'AbortError'
        ? `timed out after ${API_TIMEOUT_MS}ms`
        : err.message;
      logWarn(`Local API unavailable: ${reason}`, {
        apiPath: '/api/schedule',
        canUseBrowserSocketFallback: shouldAttemptBrowserSocketFallback(),
      });
      return false;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // MODE 2: Direct Socket.IO to Podium fallback.
  // In production this normally requires the Netlify Function proxy because
  // browsers cannot send the x-user WebSocket header Podium expects.
  // ═══════════════════════════════════════════════════════════════════════════
  function fetchFromPodiumSocket(attempt = 1) {
    return new Promise((resolve) => {
      log(`Socket.IO attempt ${attempt}/${MAX_RETRIES} (${SOCKET_TIMEOUT_MS}ms timeout)…`);
      setConnectionStatus(attempt > 1 ? 'retrying' : 'connecting');

      const userId = 'osc_' + Math.random().toString(36).substr(2, 6) + '_' + Date.now();
      let settled = false;

      const socket = io(PODIUM_URL, {
        extraHeaders: { 'x-user': userId },
        query: { parametro: EVENT_ID },
        transports: ['websocket'],
        reconnection: false,
        timeout: SOCKET_TIMEOUT_MS,
      });

      const timeoutId = setTimeout(() => {
        if (settled) return;
        settled = true;
        logWarn(
          `Socket attempt ${attempt} timed out after ${SOCKET_TIMEOUT_MS}ms. ` +
          'If this is production, verify /api/schedule is routed to the Netlify Function; browsers cannot send the x-user header Podium expects.'
        );
        socket.disconnect();

        if (attempt < MAX_RETRIES) {
          resolve(fetchFromPodiumSocket(attempt + 1));
        } else {
          logWarn(`✗ All ${MAX_RETRIES} attempts exhausted`);
          setConnectionStatus('error');
          showReadErrorState('Direct Podium socket attempts timed out.');
          resolve(false);
        }
      }, SOCKET_TIMEOUT_MS);

      socket.on('connect', () => {
        log(`  Connected on attempt ${attempt}, emitting load-data-categorias…`);
        socket.emit('load-data-categorias', { ev: EVENT_ID });
      });

      socket.on('load-data-categorias-res', (payload) => {
        if (settled) { socket.disconnect(); return; }
        clearTimeout(timeoutId);
        settled = true;

        try {
          const data = typeof payload === 'string' ? JSON.parse(payload) : payload;
          const categorias = data.data?.categorias || data.categorias || [];
          const eventItems = categorias.filter(item => item.eventoId == EVENT_ID);
          const evName = eventItems.length > 0 ? eventItems[0].evento : '';

          const ninjaItems = eventItems.filter(item => {
            const searchStr = [
              item.origen || '',
              item.estado || '',
              item.coreografia || '',
            ].join(' ').toLowerCase();
            return MATCH_KEYWORDS.some(kw => searchStr.includes(kw));
          });

          const entries = ninjaItems.map(item => ({
            turno: item.turno || null,
            categoria: item.categoria || '',
            coreografia: item.coreografia || '',
            origen: item.origen || '',
            academia: item.estado || '',
            hora: item.hora || null,
            fecha: item.fecha || '',
            estatus: item.estatusCoreografia || '',
            integrantes: item.integrantes || 0,
          }));

          lastFetchDate = new Date();
          renderSchedule({
            eventName: evName,
            totalEventEntries: eventItems.length,
            filteredCount: entries.length,
            entries: entries,
          });

          setConnectionStatus('live');
          log(`Socket attempt ${attempt} read succeeded: ${eventItems.length} total, ${entries.length} Salsa Ninja matches`);
          resolve(true);
        } catch (err) {
          logWarn(`Parse error on socket attempt ${attempt}:`, err);
          setConnectionStatus('error');
          showReadErrorState('Podium returned data the app could not parse.');
          resolve(false);
        } finally {
          socket.disconnect();
        }
      });

      socket.on('connect_error', (err) => {
        if (settled) return;
        clearTimeout(timeoutId);
        settled = true;
        logWarn(`Connection error on socket attempt ${attempt}: ${err.message}`, {
          description: err.description || null,
          context: err.context || null,
          productionHint: 'Static browsers cannot send the x-user WebSocket header; use /api/schedule via Netlify Function.',
        });
        socket.disconnect();

        if (attempt < MAX_RETRIES) {
          resolve(fetchFromPodiumSocket(attempt + 1));
        } else {
          setConnectionStatus('error');
          showReadErrorState(`Direct Podium socket failed: ${err.message}`);
          resolve(false);
        }
      });
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Main fetch orchestrator: tries local API first, falls back to Socket.IO
  // ═══════════════════════════════════════════════════════════════════════════
  async function fetchData() {
    if (isFetching) return;
    isFetching = true;
    refreshBtn.classList.add('loading');
    showLoadingState();
    setConnectionStatus('connecting');

    try {
      // If we haven't detected the mode yet, or local API was available before
      if (useLocalApi === null || useLocalApi === true) {
        const ok = await fetchFromLocalApi();
        if (ok) {
          useLocalApi = true;
          return;
        }
        // Local API not available — remember for next time, try socket
        useLocalApi = false;
      }

      if (!shouldAttemptBrowserSocketFallback()) {
        logWarn(
          'Production API read failed and direct browser Socket.IO fallback was skipped. ' +
          'Expected fix: /api/schedule must route to the Netlify Function so the request can include Podium x-user headers.',
          {
            host: window.location.host,
            protocol: window.location.protocol,
            diagnostics: 'Run window.oscDiagnostics() in the browser console for the last 100 app log entries.',
          }
        );
        setConnectionStatus('error');
        showReadErrorState('The production API route did not return a usable schedule.');
        return;
      }

      await fetchFromPodiumSocket(1);
    } finally {
      isFetching = false;
      refreshBtn.classList.remove('loading');
    }
  }

  // ─── Render Table ────────────────────────────────────────────────────────
  function renderSchedule(data) {
    eventNameText.textContent = data.eventName || 'Orlando Salsa Congress 2026';
    lastUpdateText.textContent = 'just now';
    totalEntries.textContent = data.totalEventEntries ?? '—';
    ninjaEntries.textContent = data.filteredCount ?? '—';

    const entries = data.entries || [];

    loadingState.style.display = 'none';

    if (entries.length === 0) {
      showNoPerformancesState();
      return;
    }

    emptyState.style.display = 'none';
    scheduleTable.style.display = 'table';

    const sorted = [...entries].sort(compareScheduleEntries);

    scheduleBody.innerHTML = '';
    sorted.forEach((entry, i) => {
      const tr = document.createElement('tr');
      const status = getStatusInfo(entry.estatus);
      const timeDisplay = formatTime(entry.hora);

      if (entry.estatus === 'PRESENTANDO') tr.classList.add('row-performing');
      if (entry.estatus === 'FINALIZADO') tr.classList.add('row-finished');
      tr.classList.add('row-appear');
      tr.style.animationDelay = `${i * 0.06}s`;

      tr.innerHTML = `
        <td class="cell-turn">${entry.turno || '—'}</td>
        <td class="cell-time ${!timeDisplay ? 'no-time' : ''}">${timeDisplay || 'TBD'}</td>
        <td class="cell-date">${escapeHtml(entry.fecha) || '—'}</td>
        <td class="cell-choreo">${escapeHtml(entry.coreografia) || '—'}</td>
        <td class="cell-category">${escapeHtml(entry.categoria) || '—'}</td>
        <td class="cell-origin">${escapeHtml(entry.origen)}${entry.academia ? ' — ' + escapeHtml(entry.academia) : ''}</td>
        <td class="cell-members">
          ${entry.integrantes > 1 ? `<span class="members-badge">👥 ${entry.integrantes}</span>` : '—'}
        </td>
        <td class="cell-status">
          <span class="status-badge ${status.cls}">${status.label}</span>
        </td>
      `;

      scheduleBody.appendChild(tr);
    });
  }

  // ─── Event Listeners ────────────────────────────────────────────────────
  refreshBtn.addEventListener('click', () => {
    useLocalApi = null; // re-detect on manual refresh
    fetchData();
    startCountdown();
  });

  // ─── Init ────────────────────────────────────────────────────────────────
  log('Starting OSC Live Scheduler…');
  fetchData();
  startCountdown();

  // Poll every 5 minutes
  pollTimer = setInterval(() => {
    fetchData();
    startCountdown();
  }, POLL_INTERVAL_MS);

})();
