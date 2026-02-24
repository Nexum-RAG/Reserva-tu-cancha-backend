const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());

// ─── DB ───────────────────────────────────────────────────────────────────────
const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL })
  : new Pool({
      host: process.env.DB_HOST,
      port: process.env.DB_PORT || 5432,
      database: process.env.DB_NAME,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
    });

// ─── TOKENS EN MEMORIA (simples, se limpian al reiniciar) ────────────────────
const tokens = new Set();

function generarToken() {
  return crypto.randomBytes(32).toString('hex');
}

function validarToken(req) {
  const auth = req.headers['authorization'] || '';
  const token = auth.replace('Bearer ', '').trim();
  return tokens.has(token);
}

function requireAdmin(req, res, next) {
  if (!validarToken(req)) {
    return res.status(401).json({ error: 'No autorizado' });
  }
  next();
}

// ─── INIT DB ──────────────────────────────────────────────────────────────────
async function initDB() {
  // Tabla reservas (igual que antes)
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
      estado VARCHAR(20) DEFAULT 'confirmada',
      fecha_creacion TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    ALTER TABLE reservas ADD COLUMN IF NOT EXISTS estado VARCHAR(20) DEFAULT 'confirmada'
  `);

  // Tabla precios
  await pool.query(`
    CREATE TABLE IF NOT EXISTS precios (
      id SERIAL PRIMARY KEY,
      cancha VARCHAR(100) NOT NULL UNIQUE,
      precio INTEGER NOT NULL DEFAULT 8000,
      actualizado TIMESTAMP DEFAULT NOW()
    )
  `);

  // Insertar precios iniciales si no existen
  const canchas = [
    'Cancha 1 — F8', 'Cancha 2 — F8', 'Cancha 3 — F8',
    'C1 Lado A — F6', 'C1 Lado B — F6',
    'C2 Lado A — F6', 'C2 Lado B — F6',
    'C3 Lado A — F6', 'C3 Lado B — F6',
    'Pádel 1', 'Pádel 2', 'Pádel 3'
  ];

  for (const cancha of canchas) {
    await pool.query(`
      INSERT INTO precios (cancha, precio)
      VALUES ($1, 8000)
      ON CONFLICT (cancha) DO NOTHING
    `, [cancha]);
  }

  console.log('Base de datos lista');
}

// ─── HEALTH ───────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ ok: true }));

// ─── LOGIN ADMIN ──────────────────────────────────────────────────────────────
// Credenciales se leen de variables de entorno en Easypanel:
// ADMIN_EMAIL y ADMIN_PASS
app.post('/admin/login', (req, res) => {
  const { email, password } = req.body;
  const adminEmail = process.env.ADMIN_EMAIL || 'admin@picodeportes.com';
  const adminPass = process.env.ADMIN_PASS || 'PicoAdmin2025';

  if (email === adminEmail && password === adminPass) {
    const token = generarToken();
    tokens.add(token);
    // Token expira en 8 horas
    setTimeout(() => tokens.delete(token), 8 * 60 * 60 * 1000);
    return res.json({ ok: true, token });
  }

  res.status(401).json({ error: 'Credenciales incorrectas' });
});

// ─── LOGOUT ADMIN ─────────────────────────────────────────────────────────────
app.post('/admin/logout', (req, res) => {
  const auth = req.headers['authorization'] || '';
  const token = auth.replace('Bearer ', '').trim();
  tokens.delete(token);
  res.json({ ok: true });
});

// ─── PRECIOS (públicos - para que el frontend de reservas los lea) ─────────────
app.get('/precios', async (req, res) => {
  try {
    const result = await pool.query('SELECT cancha, precio FROM precios ORDER BY id');
    // Devolver como objeto { "Cancha 1 — F8": 8000, ... }
    const precios = {};
    result.rows.forEach(r => { precios[r.cancha] = r.precio; });
    res.json(precios);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener precios' });
  }
});

// ─── ACTUALIZAR PRECIO (solo admin) ──────────────────────────────────────────
app.post('/admin/precios', requireAdmin, async (req, res) => {
  const { cancha, precio } = req.body;
  if (!cancha || precio === undefined) {
    return res.status(400).json({ error: 'Faltan datos' });
  }
  try {
    await pool.query(`
      UPDATE precios SET precio = $1, actualizado = NOW() WHERE cancha = $2
    `, [precio, cancha]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al actualizar precio' });
  }
});

// ─── DISPONIBILIDAD ───────────────────────────────────────────────────────────
app.get('/disponibilidad', async (req, res) => {
  const { cancha, fecha } = req.query;
  if (!cancha || !fecha) return res.status(400).json({ error: 'Faltan parámetros' });
  try {
    const result = await pool.query(
      "SELECT horario FROM reservas WHERE cancha = $1 AND fecha = $2 AND estado != 'cancelada'",
      [cancha, fecha]
    );
    res.json({ ocupados: result.rows.map(r => r.horario) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al consultar disponibilidad' });
  }
});

// ─── RESERVAR ─────────────────────────────────────────────────────────────────
app.post('/reservar', async (req, res) => {
  const { nombre, apellido, whatsapp, deporte, cancha, fecha, horario, precio } = req.body;
  if (!nombre || !apellido || !whatsapp || !cancha || !fecha || !horario) {
    return res.status(400).json({ error: 'Faltan datos' });
  }
  try {
    const check = await pool.query(
      "SELECT id FROM reservas WHERE cancha = $1 AND fecha = $2 AND horario = $3 AND estado != 'cancelada'",
      [cancha, fecha, horario]
    );
    if (check.rows.length > 0) {
      return res.status(409).json({ error: 'Ese horario ya está ocupado' });
    }
    const result = await pool.query(
      `INSERT INTO reservas (nombre, apellido, whatsapp, deporte, cancha, fecha, horario, precio)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [nombre, apellido, whatsapp, deporte, cancha, fecha, horario, precio]
    );
    const reservaId = result.rows[0].id;
    if (process.env.N8N_WEBHOOK_URL) {
      try {
        await fetch(process.env.N8N_WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: reservaId, nombre, apellido, whatsapp, deporte, cancha, fecha, horario, precio })
        });
      } catch (e) { console.error('Webhook error:', e); }
    }
    res.json({ ok: true, id: reservaId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al guardar la reserva' });
  }
});

// ─── CANCELAR (solo admin) ────────────────────────────────────────────────────
app.post('/cancelar/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query(
      "UPDATE reservas SET estado = 'cancelada' WHERE id = $1",
      [id]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al cancelar' });
  }
});

// ─── RESERVAS (solo admin) ────────────────────────────────────────────────────
app.get('/reservas', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM reservas ORDER BY fecha_creacion DESC LIMIT 500');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Error al obtener reservas' });
  }
});

// ─── START ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 4000;
app.listen(PORT, async () => {
  await initDB();
  console.log(`Backend corriendo en puerto ${PORT}`);
});
