// ====================================================================
// NETLIFY SERVERLESS FUNCTION: REGISTRO DE INGRESO DIARIO
// MiniHábitos - Universidad del Rosario
// ====================================================================

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://qupboqlryzmhvxjjqnqe.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InF1cGJvcWxyeXptaHZ4ampxbnFlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTI2ODk5MDMsImV4cCI6MjEwODI2NTkwM30.s_1mao9mFy7rj2yTt2GRUR10pFCUsjf491lT2E6GnVc';

// 1. Normalización de documento
function normalizarDocumento(doc) {
  if (!doc) return '';
  return String(doc).trim().replace(/[\s.,\-_]/g, '').toUpperCase();
}

// 2. Obtener fecha calendario en Colombia (America/Bogota) YYYY-MM-DD
function getFechaColombia(date = new Date()) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Bogota',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  return formatter.format(date);
}

// 3. Diferencia en días enteros entre dos fechas YYYY-MM-DD
function diferenciaDias(fecha1, fecha2) {
  const [y1, m1, d1] = fecha1.split('-').map(Number);
  const [y2, m2, d2] = fecha2.split('-').map(Number);
  const t1 = Date.UTC(y1, m1 - 1, d1);
  const t2 = Date.UTC(y2, m2 - 1, d2);
  return Math.round((t1 - t2) / (1000 * 60 * 60 * 24));
}

exports.handler = async (event, context) => {
  // Manejo de CORS
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Content-Type': 'application/json; charset=utf-8'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: 'Método no permitido. Use POST.' })
    };
  }

  try {
    const data = JSON.parse(event.body || '{}');
    const documento = normalizarDocumento(data.documento);
    const nombre = (data.nombre || 'Participante').trim();

    if (!documento || documento.length < 4) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          success: false,
          error: 'DOCUMENTO_INVALIDO',
          mensaje: 'Por favor ingresa un número de documento válido (mínimo 4 caracteres).'
        })
      };
    }

    const fechaColombia = getFechaColombia();

    // INTENTO 1: Usar la función almacenada atómica en PostgreSQL (RPC)
    try {
      const rpcResp = await fetch(`${SUPABASE_URL}/rest/v1/rpc/registrar_ingreso_diario`, {
        method: 'POST',
        headers: {
          'apikey': SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          p_documento: documento,
          p_nombre: nombre,
          p_fecha_colombia: fechaColombia
        })
      });

      if (rpcResp.ok) {
        const resultadoRPC = await rpcResp.json();
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify(resultadoRPC)
        };
      }
    } catch (rpcErr) {
      console.warn('RPC Supabase no disponible, ejecutando lógica directa:', rpcErr.message);
    }

    // INTENTO 2: Consultar directamente en tabla 'ingresos_diarios'
    const queryResp = await fetch(
      `${SUPABASE_URL}/rest/v1/ingresos_diarios?documento=eq.${encodeURIComponent(documento)}&order=fecha_colombia.desc&limit=10`,
      {
        method: 'GET',
        headers: {
          'apikey': SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
        }
      }
    );

    let registrosExistentes = [];
    let usaIngresosDiarios = true;

    if (queryResp.ok) {
      registrosExistentes = await queryResp.json();
    } else {
      // Si la tabla ingresos_diarios no ha sido creada aún en Supabase, consultar en resultados_actividades
      usaIngresosDiarios = false;
      const fallbackResp = await fetch(
        `${SUPABASE_URL}/rest/v1/resultados_actividades?correo_usuario=eq.${encodeURIComponent(documento)}&actividad=eq.ingreso_diario&order=fecha.desc&limit=10`,
        {
          method: 'GET',
          headers: {
            'apikey': SUPABASE_ANON_KEY,
            'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
          }
        }
      );
      if (fallbackResp.ok) {
        const rows = await fallbackResp.json();
        registrosExistentes = rows.map(r => ({
          fecha_colombia: r.respuesta,
          racha_calculada: parseInt(r.puntaje) || 1
        }));
      }
    }

    // Comprobar si ya existe ingreso en la fecha colombiana actual
    const ingresoHoy = registrosExistentes.find(r => r.fecha_colombia === fechaColombia);
    if (ingresoHoy) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          success: false,
          duplicado: true,
          fecha_colombia: fechaColombia,
          racha: ingresoHoy.racha_calculada || 1,
          mensaje: 'Ya registraste tu ingreso de hoy. ¡Vuelve mañana para continuar con tu racha!'
        })
      };
    }

    // Calcular racha
    let nuevaRacha = 1;
    const ultimoIngreso = registrosExistentes.find(r => r.fecha_colombia < fechaColombia);

    if (ultimoIngreso) {
      const diff = diferenciaDias(fechaColombia, ultimoIngreso.fecha_colombia);
      if (diff === 1) {
        // Ingresó ayer de forma consecutiva
        nuevaRacha = (ultimoIngreso.racha_calculada || 1) + 1;
      } else {
        // Omitió uno o más días: reiniciar en 1
        nuevaRacha = 1;
      }
    }

    // Insertar en la base de datos
    if (usaIngresosDiarios) {
      const insertResp = await fetch(`${SUPABASE_URL}/rest/v1/ingresos_diarios`, {
        method: 'POST',
        headers: {
          'apikey': SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=representation'
        },
        body: JSON.stringify({
          documento,
          nombre,
          fecha_colombia: fechaColombia,
          racha_calculada: nuevaRacha
        })
      });

      if (!insertResp.ok) {
        const errText = await insertResp.text();
        // Si falló por constraint de unicidad (petición simultánea)
        if (errText.includes('duplicate key') || errText.includes('23505') || errText.includes('uq_ingreso_documento_fecha')) {
          return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
              success: false,
              duplicado: true,
              fecha_colombia: fechaColombia,
              racha: nuevaRacha,
              mensaje: 'Ya registraste tu ingreso de hoy. ¡Vuelve mañana para continuar con tu racha!'
            })
          };
        }

        console.error('Error insertando en ingresos_diarios, intentando fallback en resultados_actividades:', errText);
        // Intentar guardar en resultados_actividades como respaldo
        await fetch(`${SUPABASE_URL}/rest/v1/resultados_actividades`, {
          method: 'POST',
          headers: {
            'apikey': SUPABASE_ANON_KEY,
            'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            correo_usuario: documento,
            nombre_usuario: nombre,
            actividad: 'ingreso_diario',
            respuesta: fechaColombia,
            seccion: 'ingreso',
            puntaje: nuevaRacha
          })
        });
      }
    } else {
      // Inserción en resultados_actividades como respaldo
      await fetch(`${SUPABASE_URL}/rest/v1/resultados_actividades`, {
        method: 'POST',
        headers: {
          'apikey': SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          correo_usuario: documento,
          nombre_usuario: nombre,
          actividad: 'ingreso_diario',
          respuesta: fechaColombia,
          seccion: 'ingreso',
          puntaje: nuevaRacha
        })
      });
    }

    // Registrar en tabla 'registros' para compatibilidad general
    fetch(`${SUPABASE_URL}/rest/v1/registros`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates'
      },
      body: JSON.stringify({ nombre, correo: documento })
    }).catch(() => {});

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        duplicado: false,
        fecha_colombia: fechaColombia,
        racha: nuevaRacha,
        mensaje: '¡Bienvenido/a! Ingreso del día registrado con éxito.'
      })
    };
  } catch (error) {
    console.error('Error en registrar-ingreso:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        success: false,
        error: 'SERVER_ERROR',
        mensaje: 'Ocurrió un error al procesar el ingreso. Intenta nuevamente.'
      })
    };
  }
};

