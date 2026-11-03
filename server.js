import express from 'express';
import pg from 'pg';
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { Pool } = pg;
const app = express();
const port = Number(process.env.PORT || 3000);
const apiKey = process.env.API_KEY;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false } });
const dirname = path.dirname(fileURLToPath(import.meta.url));

app.use(express.json({ limit: '32kb' }));
app.use(express.static(path.join(dirname, 'public')));
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && 'body' in err) return res.status(400).json({ error: 'invalid JSON' });
  next(err);
});
const error = (res, status, message) => res.status(status).json({ error: message });
const idKey = (s) => createHash('sha256').update(s).digest('hex');
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

app.use('/slots', requireKey);
app.use('/bookings', requireKey);
app.use('/reset', requireKey);
function requireKey(req, res, next) {
  if (!apiKey || req.get('X-API-Key') !== apiKey) return error(res, 401, 'invalid or missing API key');
  next();
}

app.post('/reset', async (req, res, next) => {
  const { slots } = req.body || {};
  if (!Array.isArray(slots)) return error(res, 400, 'slots must be an array');
  for (const s of slots) {
    if (!s || typeof s.id !== 'string' || !s.id.trim() || typeof s.provider !== 'string' || !s.provider.trim() ||
      !Number.isFinite(Date.parse(s.start)) || !Number.isFinite(Date.parse(s.end)) || Date.parse(s.end) <= Date.parse(s.start))
      return error(res, 400, 'each slot needs id, provider, valid start and end');
  }
  const ids = slots.map(s => s.id.trim());
  if (new Set(ids).size !== ids.length) return error(res, 400, 'slot ids must be unique');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM bookings');
    await client.query('DELETE FROM slots');
    for (const s of slots) await client.query('INSERT INTO slots(id, provider, starts_at, ends_at) VALUES($1,$2,$3,$4)', [s.id.trim(), s.provider.trim(), new Date(s.start), new Date(s.end)]);
    await client.query('COMMIT');
    res.sendStatus(200);
  } catch (e) { await client.query('ROLLBACK'); next(e); }
  finally { client.release(); }
});

app.get('/slots', async (req, res, next) => {
  try {
    const args = req.query.provider ? [req.query.provider] : [];
    const result = await pool.query(`SELECT s.id,s.provider,s.starts_at,s.ends_at,
      NOT EXISTS (SELECT 1 FROM bookings b WHERE b.slot_id=s.id AND b.status='confirmed') AS available
      FROM slots s ${args.length ? 'WHERE s.provider=$1' : ''} ORDER BY s.starts_at ASC,s.id ASC`, args);
    res.json({ slots: result.rows.map(slotJson) });
  } catch (e) { next(e); }
});
function slotJson(s) { return { id:s.id, provider:s.provider, start:new Date(s.starts_at).toISOString(), end:new Date(s.ends_at).toISOString(), available:s.available }; }
function bookingJson(b) { return { id:b.id, slot_id:b.slot_id, name:b.name, email:b.email, status:b.status, created_at:new Date(b.created_at).toISOString() }; }

app.post('/bookings', async (req, res, next) => {
  const body = req.body || {};
  const slotId = typeof body.slot_id === 'string' ? body.slot_id.trim() : '';
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const canonicalBody = JSON.stringify({ slot_id:slotId, name, email });
  const key = req.get('Idempotency-Key')?.trim();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (key) {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`idem:${key}`]);
      const previous = await client.query('SELECT body_hash,status_code,response_body FROM idempotency WHERE idem_key=$1', [key]);
      if (previous.rowCount) {
        await client.query('COMMIT');
        if (previous.rows[0].body_hash !== idKey(canonicalBody)) return error(res, 422, 'idempotency key reused with a different body');
        return res.status(previous.rows[0].status_code).json(previous.rows[0].response_body);
      }
    }
    const saveResponse = async (status, payload) => {
      if (key) await client.query('INSERT INTO idempotency(idem_key,body_hash,status_code,response_body) VALUES($1,$2,$3,$4)', [key, idKey(canonicalBody), status, JSON.stringify(payload)]);
      await client.query('COMMIT');
      res.status(status).json(payload);
    };
    if (!email) { await saveResponse(400,{error:'email is required'}); return; }
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`rate:${email}`]);
    const rate = await client.query(`SELECT count(*)::int AS n, EXTRACT(EPOCH FROM (min(created_at)+interval '1 minute'-now())) AS wait
      FROM booking_attempts WHERE email=$1 AND created_at > now()-interval '1 minute'`, [email]);
    if (rate.rows[0].n >= 5) {
      const seconds = Math.max(1, Math.ceil(Number(rate.rows[0].wait)));
      await client.query('COMMIT');
      res.set('Retry-After', String(seconds));
      return error(res, 429, 'too many booking attempts');
    }
    await client.query('INSERT INTO booking_attempts(email) VALUES($1)', [email]);
    if (!slotId || !name || !email) { await saveResponse(400,{error:'slot_id, name and email are required'}); return; }
    if (!emailPattern.test(email)) { await saveResponse(400,{error:'email is invalid'}); return; }
    const slot = await client.query('SELECT id, starts_at FROM slots WHERE id=$1', [slotId]);
    if (!slot.rowCount) { await saveResponse(404,{error:'slot not found'}); return; }
    if (new Date(slot.rows[0].starts_at) <= new Date()) { await saveResponse(400,{error:'slot has already started'}); return; }
    const id = randomUUID();
    const inserted = await client.query(`INSERT INTO bookings(id,slot_id,name,email,status) VALUES($1,$2,$3,$4,'confirmed')
      ON CONFLICT (slot_id) WHERE status='confirmed' DO NOTHING RETURNING *`, [id,slotId,name,email]);
    if (!inserted.rowCount) { await saveResponse(409,{error:'slot already booked'}); return; }
    await saveResponse(201, bookingJson(inserted.rows[0]));
  } catch (e) { try { await client.query('ROLLBACK'); } catch {} next(e); }
  finally { client.release(); }
});

app.get('/bookings', async (req, res, next) => {
  try {
    const email = typeof req.query.email === 'string' ? req.query.email.trim().toLowerCase() : '';
    const limit = req.query.limit === undefined ? 10 : Number(req.query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
      return error(res, 400, 'limit must be between 1 and 50');
    }

    let cursor;
    const cursorParam = new URL(req.originalUrl, 'http://localhost').searchParams.get('cursor');
    if (cursorParam) {
      try {
        cursor = JSON.parse(Buffer.from(cursorParam, 'base64url').toString());
      } catch {
        return error(res, 400, 'invalid cursor');
      }
      if (!cursor || !Number.isFinite(Date.parse(cursor.created_at)) || typeof cursor.id !== 'string') {
        return error(res, 400, 'invalid cursor');
      }
    }

    const result = await pool.query(
      `SELECT b.* FROM bookings b
       WHERE lower(b.email) = lower($1)
         AND (
           $2::timestamptz IS NULL
           OR b.created_at > $2::timestamptz
           OR (b.created_at = $2::timestamptz AND b.id > $3::uuid)
         )
       ORDER BY b.created_at ASC, b.id ASC
       LIMIT $4`,
      [email || '', cursor?.created_at || null, cursor?.id || null, limit + 1]
    );

    const more = result.rows.length > limit;
    const rows = result.rows.slice(0, limit);
    const last = rows.at(-1);

    res.json({
      bookings: rows.map(bookingJson),
      next_cursor: more && last
        ? Buffer.from(JSON.stringify({
            created_at: new Date(last.created_at).toISOString(),
            id: last.id
          })).toString('base64url')
        : null
    });
  } catch (e) {
    next(e);
  }
});

app.get('/bookings/:id', async (req,res,next) => {
  try { const r=await pool.query('SELECT * FROM bookings WHERE id=$1',[req.params.id]); return r.rowCount ? res.json(bookingJson(r.rows[0])) : error(res,404,'booking not found'); }
  catch(e) { next(e); }
});
app.delete('/bookings/:id', async (req,res,next) => {
  try {
    const r=await pool.query("UPDATE bookings SET status='cancelled' WHERE id=$1 AND status='confirmed' RETURNING *",[req.params.id]);
    if (r.rowCount) return res.json(bookingJson(r.rows[0]));
    const existing=await pool.query('SELECT status FROM bookings WHERE id=$1',[req.params.id]);
    return existing.rowCount ? error(res,409,'booking already cancelled') : error(res,404,'booking not found');
  } catch(e) { next(e); }
});

app.use((err,req,res,next) => { console.error(err); if (!res.headersSent) error(res,500,'internal server error'); });

async function init() {
  if (!process.env.DATABASE_URL || !apiKey) throw new Error('DATABASE_URL and API_KEY are required');
  await pool.query(`CREATE TABLE IF NOT EXISTS slots(id text PRIMARY KEY, provider text NOT NULL, starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL);
    CREATE TABLE IF NOT EXISTS bookings(id uuid PRIMARY KEY, slot_id text NOT NULL REFERENCES slots(id), name text NOT NULL, email text NOT NULL, status text NOT NULL CHECK(status IN ('confirmed','cancelled')), created_at timestamptz NOT NULL DEFAULT now());
    CREATE UNIQUE INDEX IF NOT EXISTS one_confirmed_booking_per_slot ON bookings(slot_id) WHERE status='confirmed';
    CREATE INDEX IF NOT EXISTS bookings_email_order ON bookings(email,created_at,id);
    CREATE TABLE IF NOT EXISTS idempotency(idem_key text PRIMARY KEY, body_hash text NOT NULL, status_code integer NOT NULL, response_body jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS booking_attempts(id bigserial PRIMARY KEY,email text NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
    CREATE INDEX IF NOT EXISTS booking_attempts_email_created ON booking_attempts(email,created_at);`);
  app.listen(port, () => console.log(`Clinic booking app listening on ${port}`));
}
init().catch(err => { console.error(err); process.exit(1); });
