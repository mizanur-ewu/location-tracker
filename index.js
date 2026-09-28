require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const app = express();
app.use(cors());
app.use(express.json());

// Create tables on startup
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS trips (
      id SERIAL PRIMARY KEY,
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      ended_at TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS locations (
      id SERIAL PRIMARY KEY,
      trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
      latitude DOUBLE PRECISION NOT NULL,
      longitude DOUBLE PRECISION NOT NULL,
      recorded_at TIMESTAMPTZ NOT NULL
    );
    CREATE INDEX IF NOT EXISTS locations_trip_idx ON locations(trip_id, recorded_at);
    ALTER TABLE locations ADD COLUMN IF NOT EXISTS accuracy DOUBLE PRECISION;
  `);
}

// Distance in meters between two lat/lng points (haversine)
function haversine(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLng = toRad(b.longitude - a.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// GPS drifts a few meters (much more indoors) even when you stand still.
// Keep the same numbers in mobile/src/format.js.
const MAX_ACCURACY_M = 30; // ignore fixes less accurate than this
const MIN_MOVE_M = 15; // ignore movement smaller than this

// Removes GPS noise: drops inaccurate fixes and only adds a point
// once you've moved far enough from the last kept point.
function cleanPath(points) {
  const path = [];
  for (const p of points) {
    if (p.accuracy != null && p.accuracy > MAX_ACCURACY_M) continue;
    const last = path[path.length - 1];
    if (!last || haversine(last, p) >= Math.max(MIN_MOVE_M, p.accuracy ?? 0)) path.push(p);
  }
  // Every fix was inaccurate: still show where the trip was
  if (path.length === 0 && points.length) path.push(points[0]);
  return path;
}

function pathDistance(path) {
  let total = 0;
  for (let i = 1; i < path.length; i++) total += haversine(path[i - 1], path[i]);
  return total;
}

function summarize(trip, points, path = cleanPath(points)) {
  const lastPoint = points[points.length - 1];
  const start = new Date(trip.started_at).getTime();
  // A trip that was never stopped (e.g. app closed) ends at its last point
  const end = new Date(trip.ended_at ?? lastPoint?.recorded_at ?? trip.started_at).getTime();

  return {
    ...trip,
    point_count: points.length,
    distance_meters: Math.round(pathDistance(path)),
    duration_seconds: Math.max(0, Math.round((end - start) / 1000)),
  };
}

async function getPoints(tripId) {
  const { rows } = await pool.query(
    'SELECT latitude, longitude, accuracy, recorded_at FROM locations WHERE trip_id = $1 ORDER BY recorded_at',
    [tripId]
  );
  return rows;
}

app.get('/', (req, res) => {
  res.json({ name: 'Location Tracker API', health: '/health' });
});

// Health check: confirms the server is up and the DB is reachable
app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', db: 'ok', uptime_seconds: Math.round(process.uptime()), time: new Date() });
  } catch (err) {
    res.status(503).json({ status: 'error', db: 'unreachable', error: err.message, time: new Date() });
  }
});

// Start a new trip
app.post('/trips', async (req, res) => {
  const { rows } = await pool.query('INSERT INTO trips DEFAULT VALUES RETURNING *');
  res.json(rows[0]);
});

// Stop a trip
app.post('/trips/:id/stop', async (req, res) => {
  const { rows } = await pool.query(
    'UPDATE trips SET ended_at = NOW() WHERE id = $1 RETURNING *',
    [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Trip not found' });
  res.json(rows[0]);
});

// Save a location point
app.post('/locations', async (req, res) => {
  const { trip_id, latitude, longitude, accuracy, time } = req.body;
  if (trip_id == null || latitude == null || longitude == null) {
    return res.status(400).json({ error: 'trip_id, latitude and longitude are required' });
  }
  const { rows } = await pool.query(
    'INSERT INTO locations (trip_id, latitude, longitude, accuracy, recorded_at) VALUES ($1, $2, $3, $4, $5) RETURNING *',
    [trip_id, latitude, longitude, accuracy ?? null, time ? new Date(time) : new Date()]
  );
  res.json(rows[0]);
});

// List all trips with distance and duration
app.get('/trips', async (req, res) => {
  const { rows: trips } = await pool.query('SELECT * FROM trips ORDER BY started_at DESC');
  const result = await Promise.all(trips.map(async (t) => summarize(t, await getPoints(t.id))));
  res.json(result);
});

// One trip with its path.
// `points` = every saved fix, `path` = cleaned points to draw on the map.
app.get('/trips/:id', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM trips WHERE id = $1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Trip not found' });
  const points = await getPoints(rows[0].id);
  const path = cleanPath(points);
  res.json({ ...summarize(rows[0], points, path), points, path });
});

// Basic error handler so a DB error doesn't crash the server
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message });
});

const PORT = process.env.PORT || 3000;
initDb()
  .then(() => app.listen(PORT, '0.0.0.0', () => console.log(`API running on port ${PORT}`)))
  .catch((err) => {
    console.error('Failed to init DB', err);
    process.exit(1);
  });
