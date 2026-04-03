# EigenGrid Monorepo

EigenGrid is a single repository that now contains both a Laravel backend API and a JavaScript frontend. Keeping everything together makes it easy to version backend schema changes alongside the UI.

## Repository layout
- `backend/` – Laravel 13 application that serves JSON to `frontend` and exposes authentication, profile, and static data endpoints.
- `frontend/` – A Next.js 14 (app router) client that runs standalone but talks to the Laravel API.
- `docker-compose.yml` – Spins up PostgreSQL, the backend PHP server, and the frontend dev server with one command.

## Getting started locally (without Docker)
1. `cd backend && composer install && cp .env.example .env && php artisan key:generate`
2. Set database credentials in `backend/.env` (PostgreSQL is default in this repo).
3. `php artisan migrate` to prepare the database.
4. `cd frontend && npm install && npm run dev` to start the React UI.
   - Copy `frontend/.env.example` to `.env.local` and adjust `NEXT_PUBLIC_API_URL` if your backend is hosted elsewhere.
5. The API is reachable at `http://localhost:8000`, and the Next app runs at `http://localhost:3000` by default.

## Dockerized dev loop
1. `docker-compose up --build`
2. Backend API: `http://localhost:8000`
3. Frontend: `http://localhost:3000`
4. The frontend automatically calls `/api/login` on the backend using the token returned from Laravel Sanctum.

## Testing
- Backend: `cd backend && php artisan test`
- Frontend: `cd frontend && npm run lint` (if configured) or `npm run build` for a production check.

## Next steps
- Wire additional API endpoints under `backend/routes/api.php` once the frontend UI requires them.
- Update `frontend/app/(...)` to render the actual EigenGrid dashboard once authentication is wired.
