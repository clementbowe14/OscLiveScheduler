const express = require('express');
const path = require('path');
const { io: ioClient } = require('socket.io-client');

const app = express();
const PORT = 3000;

// ─── State ───────────────────────────────────────────────────────────────────
let latestScheduleData = [];
let allCategoriesData = [];
let lastFetchTime = null;
let connectionStatus = 'disconnected';
let eventName = '';

const PODIUM_URL = 'https://live.podiumsystem.mx';
const EVENT_ID = 215;
const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// Keywords to match for "Academia Salsa Ninja Dance Academy" / "Origen"
const MATCH_KEYWORDS = [
  'salsa ninja',
  'ninja dance',
  'academia salsa ninja',
];

// ─── Scraper ─────────────────────────────────────────────────────────────────
function fetchScheduleData() {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.disconnect();
      reject(new Error('Socket connection timed out after 30s'));
    }, 30000);

    const userId = 'scraper_' + Math.random().toString(36).substr(2, 9) + '_' + Date.now();

    const socket = ioClient(PODIUM_URL, {
      extraHeaders: { 'x-user': userId },
      query: { parametro: EVENT_ID },
      transports: ['websocket'],
      reconnection: false,
    });

    socket.on('connect', () => {
      console.log(`[${new Date().toLocaleTimeString()}] ✓ Connected to Podium System`);
      connectionStatus = 'connected';
      socket.emit('load-data-categorias', { ev: EVENT_ID });
    });

    socket.on('load-data-categorias-res', (payload) => {
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
        console.log(`[${new Date().toLocaleTimeString()}] ✓ Fetched ${eventItems.length} total entries, ${filtered.length} Salsa Ninja matches`);
        connectionStatus = 'success';
        resolve(latestScheduleData);
      } catch (err) {
        console.error(`[${new Date().toLocaleTimeString()}] ✗ Parse error:`, err.message);
        connectionStatus = 'error';
        reject(err);
      } finally {
        socket.disconnect();
      }
    });

    socket.on('connect_error', (err) => {
      clearTimeout(timeout);
      console.error(`[${new Date().toLocaleTimeString()}] ✗ Connection error:`, err.message);
      connectionStatus = 'error';
      socket.disconnect();
      reject(err);
    });
  });
}

// ─── Polling Loop ────────────────────────────────────────────────────────────
async function pollSchedule() {
  try {
    await fetchScheduleData();
  } catch (err) {
    console.error(`[${new Date().toLocaleTimeString()}] ✗ Fetch failed:`, err.message);
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
    entries: latestScheduleData,
  });
});

// API: all event data (for debugging/exploration)
app.get('/api/schedule/all', (req, res) => {
  res.json({
    eventName,
    lastFetchTime,
    connectionStatus,
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
