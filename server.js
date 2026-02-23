const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// Conexión a PostgreSQL via variables de entorno
const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});

// Crear tabla si no existe
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS reservas (
      id SERIAL PRIMARY KEY,
      nombre VARCHAR(100) NOT NULL,
      apellido VARCHAR(100) NOT NULL,
      whatsapp VARCHAR(30) NOT NULL,
      deporte VARCHAR(50) NOT NULL,
      cancha VARCHAR(100) NOT NULL,
      fecha VARCHAR(100) NOT NULL,
      horario VARCHAR(10) NOT NULL,
      precio INTEGER NOT NULL,
      fecha_creacion TIMESTAMP DEFAULT NOW()
    )
  `);
  console.log('Base de datos lista');
}

// GET /disponibilidad?cancha=X&fecha=Y
app.get('/disponibilidad', async (req, res) => {
  const { cancha, fecha } = req.query;
  if (!cancha || !fecha) return res.status(400).json({ error: 'Faltan parámetros' });

  try {
    const result = await pool.query(
      'SELECT horario FROM reservas WHERE cancha = $1 AND fecha = $2',
      [cancha, fecha]
    );
    const ocupados = result.rows.map(r => r.horario);
    res.json({ ocupados });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al consultar disponibilidad' });
  }
});

// POST /reservar
app.post('/reservar', async (req, res) => {
  const { nombre, apellido, whatsapp, deporte, cancha, fecha, horario, precio } = req.body;

  if (!nombre || !apellido || !whatsapp || !cancha || !fecha || !horario) {
    return res.status(400).json({ error: 'Faltan datos' });
  }

  try {
    // Verificar que el horario no esté ocupado
    const check = await pool.query(
      'SELECT id FROM reservas WHERE cancha = $1 AND fecha = $2 AND horario = $3',
      [cancha, fecha, horario]
    );

    if (check.rows.length > 0) {
      return res.status(409).json({ error: 'Ese horario ya está ocupado' });
    }

    // Guardar reserva
    const result = await pool.query(
      `INSERT INTO reservas (nombre, apellido, whatsapp, deporte, cancha, fecha, horario, precio)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [nombre, apellido, whatsapp, deporte, cancha, fecha, horario, precio]
    );

    const reservaId = result.rows[0].id;

    // Disparar webhook a n8n si está configurado
    if (process.env.N8N_WEBHOOK_URL) {
      try {
        await fetch(process.env.N8N_WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: reservaId,
            nombre, apellido, whatsapp,
            deporte, cancha, fecha, horario, precio
          })
        });
      } catch (webhookErr) {
        console.error('Error enviando webhook a n8n:', webhookErr);
        // No falla la reserva si el webhook falla
      }
    }

    res.json({ ok: true, id: reservaId, mensaje: 'Reserva confirmada' });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al guardar la reserva' });
  }
});

// GET /reservas (para el panel del dueño - más adelante)
app.get('/reservas', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM reservas ORDER BY fecha_creacion DESC LIMIT 100'
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Error al obtener reservas' });
  }
});

// Health check
app.get('/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 4000;
app.listen(PORT, async () => {
  await initDB();
  console.log(`Backend Pico Deportes corriendo en puerto ${PORT}`);
});
