# Running IncidentOS with Docker

Runs the webhook server and dashboard as two containers from a single multi-stage
`Dockerfile`. Postgres is not containerized — `DATABASE_URL` points at external Neon and
is passed through from `.env`. The native workflow (`npm run dev`, etc.) still works.

| Service     | Port | Command                       |
|-------------|------|-------------------------------|
| `webhook`   | 3000 | `node dist/webhook/server.js` |
| `dashboard` | 3001 | `next start -p 3001`          |

## Setup

```bash
cp .env.example .env    # set ANTHROPIC_API_KEY and DATABASE_URL
```

## Build and run

```bash
docker compose up --build       # foreground
docker compose up --build -d    # detached
```

- Webhook → http://localhost:3000 (`POST /webhook`, `GET /health`)
- Dashboard → http://localhost:3001

## Logs

```bash
docker compose logs -f webhook
docker compose logs -f dashboard
```

## Stop

```bash
docker compose down             # remove containers
docker compose down --rmi local # also remove images
```

## Tests

Runtime images ship without devDependencies or source, so tests run in the `builder`
stage via the `test` service:

```bash
docker compose run --rm test                    # vitest unit suite
docker compose run --rm test npm run build:api  # type check
docker compose run --rm test npm run test:run   # e2e (needs ANTHROPIC_API_KEY)
docker compose run --rm test npm run verify:db  # DB long-gap check (needs DATABASE_URL)
```
