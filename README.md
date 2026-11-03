# VarsityONE University Academic Platform

VarsityONE is a university academic management platform with student, lecturer, department administrator and super administrator workspaces. The web client is React, TypeScript and Material UI. The API uses Node.js and Neon PostgreSQL, with versioned schema migrations, database-enforced academic constraints, secure sessions, role checks and auditable academic workflows.

## GitHub CI/CD

The GitHub Actions workflow at `.github/workflows/production-deploy.yml` runs the TypeScript production build for pull requests and pushes to `main`. Successful pushes to `main` deploy the prebuilt application to the linked Vercel production project. Vercel must have the production Neon environment variables configured in Project Settings.

Add a Vercel access token as the GitHub repository Actions secret named `VERCEL_TOKEN` (Settings → Secrets and variables → Actions). Never commit a token or a populated `.env` file. Pull requests only run the build; they do not receive the production token or deploy.

## Stack

- React 19, TypeScript, Vite and Material UI 7.
- Node.js 24.x HTTP API (pinned to the Vercel-supported LTS major).
- Neon PostgreSQL using the `pg` pool and a Neon pooled connection string.
- SQL migrations with checksums and a PostgreSQL advisory lock.
- Docker multi-stage build for a small production runtime image.

## Configure Neon

Copy `.env.example` to `.env` and set `DATABASE_URL` to the pooled PostgreSQL connection string from Neon. Keep the populated file private; it is excluded from Docker builds and should not be committed. The service fails closed if the URL is missing, database access fails, or migrations have not been applied.

Run the migration once for the target Neon branch:

```powershell
npm run db:migrate
```

Migrations are serialized with a Postgres advisory lock and recorded with SHA-256 checksums. An already applied migration cannot be edited silently; add the next numbered SQL file under `migrations/` for future changes.

For a new production database, bootstrap the first super administrator with `VARSITYONE_ADMIN_EMAIL`, `VARSITYONE_ADMIN_NAME`, and a unique `VARSITYONE_ADMIN_PASSWORD` of at least 16 characters, then run `npm run db:create-admin` once. The script refuses to create a second super administrator, locks concurrent bootstrap attempts, and stores only a scrypt password hash.

## Run locally

Install dependencies with `npm ci`. Start the API in one terminal and Vite in another:

```powershell
npm run dev:api
npm run dev
```

The API listens on port 3000 and the React app on port 5173. Vite proxies `/api` to the API. Open [http://localhost:5173](http://localhost:5173).

Build and serve the production bundle:

```powershell
npm run build
npm start
```

The production API serves `dist/` on port 3000. Set `PORT`, `DB_POOL_MAX`, `DB_POOL_MIN`, and `APP_ORIGINS` through environment variables as needed. The default pool maximum is ten connections and is intended for the Neon pooled endpoint. Tune the pool against the Neon plan's connection limit before adding application replicas.

## Deploy on Vercel

The Vercel configuration builds the TypeScript/MUI frontend as static assets and routes `/api/*` to a Node serverless function. The function uses Neon’s pooled connection URL and a five-connection per-instance pool by default. The VarsityONE Vercel project must have `DATABASE_URL` set as a sensitive Production environment variable before deployment; set it for Preview only if preview deployments should share a database. Schema migrations are applied separately with `npm run db:migrate` before deployment. The production deployment is served at `https://varsityone.vercel.app`.

After linking the Vercel project, deploy with `vercel --prod`. Vercel serves hashed `/assets/*` files with immutable caching and applies the app’s security headers. API function initialization checks that migrations are present and returns a retryable 503 if Neon is temporarily unavailable.

## Institutional data

Production startup does not insert data. The reviewed institutional dataset is generated and stored in Neon by the explicit seed command. It prepares nine departments, 42 lecturers, 189 students, 432 courses and their course assignments, registrations, results and audit history. Re-running it is idempotent for seeded identities and records. It requires the explicit production-data confirmation below and an active `odinigwechu137@gmail.com` super administrator:

```powershell
npm run db:seed-institution
```

Set `VARSITYONE_CONFIRM_PRODUCTION_DATA=I_CONFIRM_VARSITYONE_PRODUCTION_DATA` and `VARSITYONE_TARGET_BRANCH=production` only in the protected operator environment immediately before running the seed. Set `VARSITYONE_TEST_HOD_PASSWORD`, `VARSITYONE_TEST_LECTURER_PASSWORD`, `VARSITYONE_TEST_STUDENT_PASSWORD`, and `VARSITYONE_TEST_STUDENT2_PASSWORD` to distinct passwords of at least 20 characters. The production owner account remains the only super administrator seeded by this dataset. Student, lecturer and department-admin workflows can be exercised through these hidden test accounts. Use the institution-issued account for super-admin access; none of these accounts appear as login shortcuts:

| Role | Email | Password |
|---|---|---|
| Department Admin | `hod@uemp.demo` | Issued securely to the operator |
| Lecturer | `lecturer@uemp.demo` | Issued securely to the operator |
| Student | `student@uemp.demo` | Issued securely to the operator |
| Student (second record) | `student2@uemp.demo` | Issued securely to the operator |

These role accounts are for controlled workflow verification. Each account has a distinct high-entropy password; synthetic roster accounts receive independent random credentials. Use the institution-issued account for normal access; the login page does not expose these accounts or passwords.

## Workflows

1. **Student registration:** a student sees only active courses for the current semester, their department, programme and level. Registration uses one atomic insert and a unique database constraint prevents duplicates.
2. **Lecturer grading:** assigned lecturers view scoped class lists, save CA and exam scores as drafts, then submit a complete class. CA is capped at 30 and exam at 70. A bulk `UNNEST` write persists the full roster in one database round trip.
3. **Department review:** a department administrator or super admin reviews submitted scores and approves them or returns them with required feedback. Approval is transactional and only complete class submissions can be approved. Students only receive approved results.
4. **University management:** super admins manage faculties, departments, programmes, accounts, roles, sessions, semesters, courses, allocations and course status. Department administrators are scoped to their own department.

See [DEMO.md](DEMO.md) for a concise walkthrough, [TECHNICAL.md](TECHNICAL.md) for architecture and permissions, and [DATABASE.md](DATABASE.md) for the entity relationship design.

## Grading and CGPA

| Score | Grade | Grade point |
|---:|:---:|---:|
| 70–100 | A | 5 |
| 60–69 | B | 4 |
| 50–59 | C | 3 |
| 45–49 | D | 2 |
| 40–44 | E | 1 |
| 0–39 | F | 0 |

CGPA = sum of (approved course grade point × course units) ÷ total approved course units. The server applies the grading scale on every score write. Students do not see results until department approval.

## Production deployment

The Docker image builds the frontend in a separate stage and installs production dependencies only in the runtime stage. Provide `DATABASE_URL` as a deployment secret. Apply migrations as a release step before starting the new application version:

```powershell
docker compose run --rm uemp npm run db:migrate
docker compose up -d --build
```

The container binds port 3000 to loopback in the supplied Compose file. Put it behind a TLS-terminating reverse proxy, set `NODE_ENV=production` so the session cookie has the `Secure` flag, and set `TRUST_PROXY=true` only when the service is reachable exclusively through a trusted proxy. Configure `APP_ORIGINS` to the exact application origin(s). Keep the Neon pooled connection string in the hosting provider's secret manager, enable Neon backups/restore for the production branch, and monitor `/api/health` plus application logs.

The API is designed for multiple stateless app instances behind a load balancer; signed opaque sessions are stored in Neon. Keep the pool ceiling within Neon connection limits. Migrations use a database advisory lock so parallel release jobs do not apply the same migration twice. SQL has explicit query, lock and idle-transaction timeouts. Serializable transactions retry serialization and deadlock conflicts with bounded backoff.

## Operational hardening

- Scrypt password hashes have a unique random salt. Session cookies are HttpOnly, SameSite=Strict and eight hours long; only token hashes are stored. Logout, account suspension and role changes revoke sessions.
- API mutations validate request origin. Login is rate limited per client IP. Request bodies are capped at 1 MB. Database errors return safe messages and structured server logs include a request ID.
- PostgreSQL constraints and indexes enforce uniqueness, score ranges, cross-department programme relationships and result-to-registration links. The API adds role and ownership checks.
- Audit events are append-only through the product API and cover result, registration and administrative actions. Search is indexed by actor, entity, time and JSON details.
- Health checks verify database connectivity. Expired sessions are cleaned up hourly. The process closes the HTTP listener and drains the pool on termination.

This assessment platform does not include admissions, fee payment, accommodation, attendance, external identity providers, password recovery, MFA, messaging gateways, native mobile apps, transcript certification or integration with an existing student information system. Those require institution-specific policy and integration decisions.
