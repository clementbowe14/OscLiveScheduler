const express = require('express');
const path = require('path');
const { io: ioClient } = require('socket.io-client');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── State ───────────────────────────────────────────────────────────────────
let latestScheduleData = [];
let allCategoriesData = [];
let lastFetchTime = null;
let connectionStatus = 'disconnected';
let eventName = '';
let lastError = null;

const PODIUM_URL = process.env.PODIUM_URL || 'https://live.podiumsystem.mx';
const EVENT_ID = Number(process.env.PODIUM_EVENT_ID || 215);
const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const PODIUM_READ_TIMEOUT_MS = Number(process.env.PODIUM_READ_TIMEOUT_MS || 55000);

// Keywords to match for "Academia Salsa Ninja Dance Academy" / "Origen"
const MATCH_KEYWORDS = [
  'salsa ninja',
  'ninja dance',
  'academia salsa ninja',
];

// ─── Scraper ─────────────────────────────────────────────────────────────────
function podiumLog(message, details) {
  const prefix = `[${new Date().toLocaleTimeString()}] [Podium] ${message}`;
  if (details === undefined) {
    console.log(prefix);
  } else {
    console.log(prefix, details);
  }
}

function podiumError(message, details) {
  const prefix = `[${new Date().toLocaleTimeString()}] [Podium] ${message}`;
  if (details === undefined) {
    console.error(prefix);
  } else {
    console.error(prefix, details);
  }
}

function summarizeItem(item) {
  if (!item) return null;
  return {
    eventoId: item.eventoId,
    evento: item.evento,
    turno: item.turno,
    categoria: item.categoria,
    coreografia: item.coreografia,
    origen: item.origen,
    estado: item.estado,
    hora: item.hora,
    fecha: item.fecha,
    estatusCoreografia: item.estatusCoreografia,
  };
}

function fetchScheduleData() {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    let settled = false;
    const userId = 'scraper_' + Math.random().toString(36).substr(2, 9) + '_' + Date.now();

    podiumLog('Connecting', {
      url: PODIUM_URL,
      eventId: EVENT_ID,
      timeoutMs: PODIUM_READ_TIMEOUT_MS,
      hasXUserHeader: true,
      transport: 'websocket',
    });

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.disconnect();
      const err = new Error(`Socket read timed out after ${PODIUM_READ_TIMEOUT_MS}ms`);
      lastError = err.message;
      connectionStatus = 'error';
      podiumError(err.message, { elapsedMs: Date.now() - startedAt });
      reject(err);
    }, PODIUM_READ_TIMEOUT_MS);

    const socket = ioClient(PODIUM_URL, {
      extraHeaders: { 'x-user': userId },
      query: { parametro: EVENT_ID },
      transports: ['websocket'],
      reconnection: false,
      timeout: PODIUM_READ_TIMEOUT_MS,
    });

    socket.on('connect', () => {
      podiumLog('Connected; requesting categories', {
        elapsedMs: Date.now() - startedAt,
        socketId: socket.id,
      });
      connectionStatus = 'connected';
      socket.emit('load-data-categorias', { ev: EVENT_ID });
    });

    socket.on('load-data-categorias-res', (payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try {
        const data = typeof payload === 'string' ? JSON.parse(payload) : payload;
        const categorias = data.data?.categorias || data.categorias || [];

        // Store all data for the event
        const eventItems = categorias.filter(item => item.eventoId == EVENT_ID);

        if (eventItems.length > 0 && eventItems[0].evento) {
          eventName = eventItems[0].evento;
        }

        allCategoriesData = eventItems;

        // Filter for Salsa Ninja entries
        const filtered = eventItems.filter(item => {
          const searchStr = [
            item.origen || '',
            item.estado || '',
            item.coreografia || '',
          ].join(' ').toLowerCase();

          return MATCH_KEYWORDS.some(kw => searchStr.includes(kw));
        });

        latestScheduleData = filtered.map(item => ({
          turno: item.turno || null,
          categoria: item.categoria || '',
          coreografia: item.coreografia || '',
          origen: item.origen || '',
          academia: item.estado || '',
          hora: item.hora || null,
          fecha: item.fecha || '',
          estatus: item.estatusCoreografia || '',
          estatusCategoria: item.estatusCategoria || '',
          integrantes: item.integrantes || 0,
          competenciaId: item.competenciaId || '',
          noSeguimiento: item.noSeguimiento || 0,
        }));

        lastFetchTime = new Date().toISOString();
        lastError = null;
        podiumLog('Payload parsed', {
          payloadType: typeof payload,
          topLevelKeys: data && typeof data === 'object' ? Object.keys(data).slice(0, 12) : [],
          totalCategorias: categorias.length,
          totalEventEntries: eventItems.length,
          filteredCount: filtered.length,
          eventName,
          firstEventItem: summarizeItem(eventItems[0]),
          firstMatchedItem: summarizeItem(filtered[0]),
          elapsedMs: Date.now() - startedAt,
        });
        connectionStatus = 'success';
        resolve(latestScheduleData);
      } catch (err) {
        lastError = err.message;
        podiumError('Parse error', {
          message: err.message,
          payloadPreview: typeof payload === 'string' ? payload.slice(0, 300) : payload,
          elapsedMs: Date.now() - startedAt,
        });
        connectionStatus = 'error';
        reject(err);
      } finally {
        socket.disconnect();
      }
    });

    socket.on('connect_error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      lastError = err.message;
      podiumError('Connection error', {
        message: err.message,
        description: err.description || null,
        context: err.context || null,
        elapsedMs: Date.now() - startedAt,
      });
      connectionStatus = 'error';
      socket.disconnect();
      reject(err);
    });

    socket.on('disconnect', (reason) => {
      podiumLog('Socket disconnected', {
        reason,
        settled,
        elapsedMs: Date.now() - startedAt,
      });
    });
  });
}

// ─── Polling Loop ────────────────────────────────────────────────────────────
async function pollSchedule() {
  try {
    await fetchScheduleData();
  } catch (err) {
    podiumError('Fetch failed', { message: err.message });
  }
}

// Initial fetch + recurring interval
pollSchedule();
setInterval(pollSchedule, POLL_INTERVAL_MS);

// ─── Express Routes ──────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// API: filtered Salsa Ninja data
app.get('/api/schedule', (req, res) => {
  res.json({
    eventName,
    lastFetchTime,
    connectionStatus,
    pollIntervalMs: POLL_INTERVAL_MS,
    matchKeywords: MATCH_KEYWORDS,
    totalEventEntries: allCategoriesData.length,
    filteredCount: latestScheduleData.length,
    lastError,
    source: 'local-server',
    entries: latestScheduleData,
  });
});

// API: all event data (for debugging/exploration)
app.get('/api/schedule/all', (req, res) => {
  res.json({
    eventName,
    lastFetchTime,
    connectionStatus,
    lastError,
    totalEntries: allCategoriesData.length,
    entries: allCategoriesData.map(item => ({
      turno: item.turno,
      categoria: item.categoria,
      coreografia: item.coreografia,
      origen: item.origen,
      academia: item.estado,
      hora: item.hora,
      fecha: item.fecha,
      estatus: item.estatusCoreografia,
      integrantes: item.integrantes,
    })),
  });
});

// API: force refresh
app.post('/api/refresh', async (req, res) => {
  try {
    const data = await fetchScheduleData();
    res.json({ success: true, count: data.length });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`\n🎶 OSC Live Scheduler running at http://localhost:${PORT}`);
  console.log(`   Tracking: Academia Salsa Ninja Dance Academy`);
  console.log(`   Source: ${PODIUM_URL}/minuto?ev=${EVENT_ID}`);
  console.log(`   Polling every ${POLL_INTERVAL_MS / 1000 / 60} minutes\n`);
});
