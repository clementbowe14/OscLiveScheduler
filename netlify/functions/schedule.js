const { io: ioClient } = require('socket.io-client');

const PODIUM_URL = process.env.PODIUM_URL || 'https://live.podiumsystem.mx';
const EVENT_ID = Number(process.env.PODIUM_EVENT_ID || 215);
const PODIUM_READ_TIMEOUT_MS = Number(process.env.PODIUM_READ_TIMEOUT_MS || 55000);

const MATCH_KEYWORDS = [
  'salsa ninja',
  'ninja dance',
  'academia salsa ninja',
];

let cachedSchedule = null;

function log(requestId, message, details = undefined) {
  const prefix = `[podium:${requestId}] ${message}`;
  if (details === undefined) {
    console.log(prefix);
  } else {
    console.log(prefix, details);
  }
}

function logError(requestId, message, details = undefined) {
  const prefix = `[podium:${requestId}] ${message}`;
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

function normalizePayload(payload, requestId) {
  const data = typeof payload === 'string' ? JSON.parse(payload) : payload;
  const categorias = data?.data?.categorias || data?.categorias || [];
  const eventItems = categorias.filter((item) => item.eventoId == EVENT_ID);
  const eventName = eventItems.length > 0 && eventItems[0].evento ? eventItems[0].evento : '';

  const filtered = eventItems.filter((item) => {
    const searchStr = [
      item.origen || '',
      item.estado || '',
      item.coreografia || '',
    ].join(' ').toLowerCase();

    return MATCH_KEYWORDS.some((kw) => searchStr.includes(kw));
  });

  const entries = filtered.map((item) => ({
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

  log(requestId, 'Payload parsed', {
    payloadType: typeof payload,
    topLevelKeys: data && typeof data === 'object' ? Object.keys(data).slice(0, 12) : [],
    totalCategorias: categorias.length,
    totalEventEntries: eventItems.length,
    filteredCount: entries.length,
    eventName,
    firstEventItem: summarizeItem(eventItems[0]),
    firstMatchedItem: summarizeItem(filtered[0]),
  });

  return {
    eventName,
    lastFetchTime: new Date().toISOString(),
    connectionStatus: 'success',
    pollIntervalMs: 5 * 60 * 1000,
    matchKeywords: MATCH_KEYWORDS,
    totalEventEntries: eventItems.length,
    filteredCount: entries.length,
    entries,
    source: 'netlify-function',
  };
}

function fetchScheduleData(requestId) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const userId = `netlify_${Math.random().toString(36).slice(2, 11)}_${Date.now()}`;
    let settled = false;

    log(requestId, 'Connecting to Podium', {
      url: PODIUM_URL,
      eventId: EVENT_ID,
      timeoutMs: PODIUM_READ_TIMEOUT_MS,
      hasXUserHeader: true,
      transport: 'websocket',
      cachedAt: cachedSchedule?.lastFetchTime || null,
    });

    const socket = ioClient(PODIUM_URL, {
      extraHeaders: { 'x-user': userId },
      query: { parametro: EVENT_ID },
      transports: ['websocket'],
      reconnection: false,
      timeout: PODIUM_READ_TIMEOUT_MS,
    });

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.disconnect();
      const err = new Error(`Socket read timed out after ${PODIUM_READ_TIMEOUT_MS}ms`);
      logError(requestId, err.message, { elapsedMs: Date.now() - startedAt });
      reject(err);
    }, PODIUM_READ_TIMEOUT_MS);

    socket.on('connect', () => {
      log(requestId, 'Connected; requesting categories', {
        elapsedMs: Date.now() - startedAt,
        socketId: socket.id,
      });
      socket.emit('load-data-categorias', { ev: EVENT_ID });
    });

    socket.on('load-data-categorias-res', (payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);

      try {
        const response = normalizePayload(payload, requestId);
        log(requestId, 'Read succeeded', {
          elapsedMs: Date.now() - startedAt,
          totalEventEntries: response.totalEventEntries,
          filteredCount: response.filteredCount,
        });
        cachedSchedule = response;
        resolve(response);
      } catch (err) {
        logError(requestId, 'Payload parse failed', {
          message: err.message,
          elapsedMs: Date.now() - startedAt,
          payloadPreview: typeof payload === 'string' ? payload.slice(0, 300) : payload,
        });
        reject(err);
      } finally {
        socket.disconnect();
      }
    });

    socket.on('connect_error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.disconnect();
      logError(requestId, 'Connection failed', {
        message: err.message,
        description: err.description || null,
        context: err.context || null,
        elapsedMs: Date.now() - startedAt,
      });
      reject(err);
    });

    socket.on('disconnect', (reason) => {
      log(requestId, 'Socket disconnected', {
        reason,
        settled,
        elapsedMs: Date.now() - startedAt,
      });
    });
  });
}

exports.handler = async (event, context) => {
  context.callbackWaitsForEmptyEventLoop = false;

  const requestId = context.awsRequestId || `${Date.now()}`;

  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
      body: '',
    };
  }

  if (event.httpMethod !== 'GET') {
    return {
      statusCode: 405,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: false, error: 'Method not allowed' }),
    };
  }

  try {
    const data = await fetchScheduleData(requestId);
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      },
      body: JSON.stringify(data),
    };
  } catch (err) {
    if (cachedSchedule) {
      const staleBody = {
        ...cachedSchedule,
        connectionStatus: 'stale',
        lastError: err.message,
        source: 'netlify-function-cache',
      };

      logError(requestId, 'Returning cached schedule after live read failed', {
        error: err.message,
        cachedAt: cachedSchedule.lastFetchTime,
        totalEventEntries: cachedSchedule.totalEventEntries,
        filteredCount: cachedSchedule.filteredCount,
      });

      return {
        statusCode: 200,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        },
        body: JSON.stringify(staleBody),
      };
    }

    const body = {
      success: false,
      error: err.message,
      eventName: '',
      lastFetchTime: null,
      connectionStatus: 'error',
      totalEventEntries: 0,
      filteredCount: 0,
      lastError: err.message,
      entries: [],
      source: 'netlify-function',
    };

    logError(requestId, 'Request failed', body);

    return {
      statusCode: 502,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      },
      body: JSON.stringify(body),
    };
  }
};
