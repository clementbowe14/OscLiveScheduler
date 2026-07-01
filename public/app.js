/* ═══════════════════════════════════════════════════════════════════════════
   OSC Live Scheduler — Frontend Application Logic
   
   Dual-mode fetching:
     1. Tries the local API first (/api/schedule) — fast, no CORS issues
     2. Falls back to direct Socket.IO to Podium if no backend is available
   
   Retry logic: if any attempt exceeds 500ms, it disconnects and retries
   up to MAX_RETRIES times.
   ═══════════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  // ─── Config ──────────────────────────────────────────────────────────────
  const PODIUM_URL = 'https://live.podiumsystem.mx';
  const EVENT_ID = 215;
  const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
  const SOCKET_TIMEOUT_MS = 500;           // 500ms before retry
  const MAX_RETRIES = 5;

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

  function log(msg, ...args) {
    const ts = new Date().toLocaleTimeString();
    console.log(`[OSC ${ts}] ${msg}`, ...args);
  }

  function logWarn(msg, ...args) {
    const ts = new Date().toLocaleTimeString();
    console.warn(`[OSC ${ts}] ${msg}`, ...args);
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
    log('Trying local API at /api/schedule …');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);

    try {
      const res = await fetch('/api/schedule', { signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      if (!data.lastFetchTime) throw new Error('No data from backend yet');

      lastFetchDate = new Date();
      renderSchedule(data);
      setConnectionStatus('live');
      log(`✓ Local API: ${data.totalEventEntries} total, ${data.filteredCount} Salsa Ninja matches`);
      return true;
    } catch (err) {
      clearTimeout(timer);
      log(`✗ Local API unavailable: ${err.message}`);
      return false;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // MODE 2: Direct Socket.IO to Podium (for static/Netlify deployment)
  //         With 500ms timeout + retry logic
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

      // ── 500ms timeout: if no response, kill and retry ──
      const timeoutId = setTimeout(() => {
        if (settled) return;
        settled = true;
        logWarn(`⏱ Attempt ${attempt} timed out after ${SOCKET_TIMEOUT_MS}ms`);
        socket.disconnect();

        if (attempt < MAX_RETRIES) {
          resolve(fetchFromPodiumSocket(attempt + 1));
        } else {
          logWarn(`✗ All ${MAX_RETRIES} attempts exhausted`);
          setConnectionStatus('error');
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
          log(`✓ Socket attempt ${attempt}: ${eventItems.length} total, ${entries.length} Salsa Ninja matches`);
          resolve(true);
        } catch (err) {
          logWarn(`✗ Parse error on attempt ${attempt}:`, err);
          setConnectionStatus('error');
          resolve(false);
        } finally {
          socket.disconnect();
        }
      });

      socket.on('connect_error', (err) => {
        if (settled) return;
        clearTimeout(timeoutId);
        settled = true;
        logWarn(`✗ Connection error on attempt ${attempt}: ${err.message}`);
        socket.disconnect();

        if (attempt < MAX_RETRIES) {
          resolve(fetchFromPodiumSocket(attempt + 1));
        } else {
          setConnectionStatus('error');
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

      // Fall back to direct Socket.IO with retry logic
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
      emptyState.style.display = 'flex';
      scheduleTable.style.display = 'none';
      return;
    }

    emptyState.style.display = 'none';
    scheduleTable.style.display = 'table';

    // Sort: performing first, then waiting, then finished; then by turn
    const statusOrder = { 'PRESENTANDO': 0, 'ACTIVO': 1, 'FINALIZADO': 2 };
    const sorted = [...entries].sort((a, b) => {
      const sa = statusOrder[a.estatus] ?? 1;
      const sb = statusOrder[b.estatus] ?? 1;
      if (sa !== sb) return sa - sb;
      return (a.turno || 999) - (b.turno || 999);
    });

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
