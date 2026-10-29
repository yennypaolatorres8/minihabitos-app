// ====================================================================
// NETLIFY SERVERLESS FUNCTION: CONSULTA DE RACHA Y ESTADO DIARIO
// MiniHábitos - Universidad del Rosario
// ====================================================================

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://qupboqlryzmhvxjjqnqe.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InF1cGJvcWxyeXptaHZ4ampxbnFlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTI2ODk5MDMsImV4cCI6MjEwODI2NTkwM30.s_1mao9mFy7rj2yTt2GRUR10pFCUsjf491lT2E6GnVc';

function normalizarDocumento(doc) {
  if (!doc) return '';
  return String(doc).trim().replace(/[\s.,\-_]/g, '').toUpperCase();
}

function getFechaColombia(date = new Date()) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Bogota',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  return formatter.format(date);
}

function diferenciaDias(fecha1, fecha2) {
  const [y1, m1, d1] = fecha1.split('-').map(Number);
  const [y2, m2, d2] = fecha2.split('-').map(Number);
  const t1 = Date.UTC(y1, m1 - 1, d1);
  const t2 = Date.UTC(y2, m2 - 1, d2);
  return Math.round((t1 - t2) / (1000 * 60 * 60 * 24));
}

exports.handler = async (event, context) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Content-Type': 'application/json; charset=utf-8'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  const rawDoc = event.queryStringParameters?.documento || '';
  const documento = normalizarDocumento(rawDoc);

  if (!documento) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'Falta el parámetro documento' })
    };
  }

  const fechaColombia = getFechaColombia();

  try {
    // 1. Intentar RPC
    try {
      const rpcResp = await fetch(`${SUPABASE_URL}/rest/v1/rpc/consultar_racha_usuario`, {
        method: 'POST',
        headers: {
          'apikey': SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          p_documento: documento,
          p_fecha_colombia: fechaColombia
        })
      });
      if (rpcResp.ok) {
        const res = await rpcResp.json();
        return { statusCode: 200, headers, body: JSON.stringify(res) };
      }
    } catch(e) {}

    // 2. Consulta directa
    const queryResp = await fetch(
      `${SUPABASE_URL}/rest/v1/ingresos_diarios?documento=eq.${encodeURIComponent(documento)}&order=fecha_colombia.desc&limit=5`,
      {
        headers: {
          'apikey': SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
        }
      }
    );

    let registros = [];
    if (queryResp.ok) {
      registros = await queryResp.json();
    } else {
      // Fallback a resultados_actividades
      const fallbackResp = await fetch(
        `${SUPABASE_URL}/rest/v1/resultados_actividades?correo_usuario=eq.${encodeURIComponent(documento)}&actividad=eq.ingreso_diario&order=fecha.desc&limit=5`,
        {
          headers: {
            'apikey': SUPABASE_ANON_KEY,
            'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
          }
        }
      );
      if (fallbackResp.ok) {
        const rows = await fallbackResp.json();
        registros = rows.map(r => ({
          fecha_colombia: r.respuesta,
          racha_calculada: parseInt(r.puntaje) || 1
        }));
      }
    }

    if (registros.length === 0) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          existe: false,
          ya_ingreso_hoy: false,
          racha_actual: 0,
          ultimo_ingreso: null,
          fecha_colombia: fechaColombia
        })
      };
    }

    const ultimo = registros[0];
    const yaIngresoHoy = ultimo.fecha_colombia === fechaColombia;
    const diff = diferenciaDias(fechaColombia, ultimo.fecha_colombia);

    let rachaVigente = 0;
    if (yaIngresoHoy) {
      rachaVigente = ultimo.racha_calculada || 1;
    } else if (diff === 1) {
      rachaVigente = ultimo.racha_calculada || 1; // Mantiene racha de ayer viva esperando el ingreso de hoy
    } else {
      rachaVigente = 0; // Se rompió la racha
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        existe: true,
        ya_ingreso_hoy: yaIngresoHoy,
        racha_actual: rachaVigente,
        ultimo_ingreso: ultimo.fecha_colombia,
        fecha_colombia: fechaColombia
      })
    };
  } catch(err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message })
    };
  }
};

