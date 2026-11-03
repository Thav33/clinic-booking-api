# Clinic booking API

A single Node.js service and patient booking page that implements the Koya assessment contract through Level 5. PostgreSQL persists slots, bookings, idempotency results, and per-email attempt history.

## Run locally

1. Install Node.js 20 or newer and create a PostgreSQL database (Neon works).
2. Copy `.env.example` to `.env` and set `DATABASE_URL` and a strong `API_KEY`.
3. Run `npm install`, then `npm start`. The service initializes its tables on startup and serves the page at `http://localhost:3000`.
4. The page prompts for the API key. Enter the same key configured on the server. The key is saved in this browser only; do not embed a production key in the HTML or publish a key in GitHub.

## Initialize slots

The API starts with no slots. Send a one-time reset request using your own future slot schedule:

```sh
curl -X POST http://localhost:3000/reset \
  -H 'Content-Type: application/json' \
  -H 'X-API-Key: YOUR_API_KEY' \
  -d '{"slots":[{"id":"s1","provider":"Dr Ade","start":"2026-12-10T09:00:00Z","end":"2026-12-10T09:30:00Z"},{"id":"s2","provider":"Dr Bello","start":"2026-12-10T10:00:00Z","end":"2026-12-10T10:30:00Z"}]}'
```

`POST /reset` intentionally replaces all slots and deletes bookings, so only use it to initialize or deliberately reseed the assessment database.

## Deploy on Neon + Render

1. In Neon, create a project/database and copy the pooled connection string. Keep the password private.
2. Push this folder to a private or public GitHub repository. Do not commit `.env` or any secrets.
3. In Render, create a **Web Service** connected to that repository. Set build command to `npm install` and start command to `npm start`.
4. Add Render environment variables `DATABASE_URL` (the Neon connection string) and `API_KEY` (a long random secret). Render provides the public HTTPS URL after deploy.
5. Open the Render URL, enter the same API key when prompted, then initialize slots by sending `POST https://YOUR-RENDER-URL/reset` with the example JSON and your actual API key.
6. Confirm the page can load slots and make a booking. Keep the Render service and Neon database active after submission.

The API requires `X-API-Key` on every `/slots`, `/bookings`, and `/reset` request. The page uses that header for its calls. Since a browser-based client necessarily holds its API key, treat this page as an assessment/demo UI and rotate the key if it is exposed. For a public production patient site, put a trusted server-side frontend/BFF in front of the API rather than distributing a shared clinic secret.

## Contract endpoints

- `POST /reset` replace slots
- `GET /slots?provider=...` sorted slots and availability
- `POST /bookings` create; supports idempotency and per-email throttling
- `GET /bookings/{id}` lookup
- `DELETE /bookings/{id}` cancel
- `GET /bookings?email=...&limit=10&cursor=...` cursor-paginated history
