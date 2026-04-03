# EigenGrid

EigenGrid is a web app split into a Laravel API and a JavaScript frontend.

## What lives where
- `backend/` contains the Laravel application and JSON API.
- `frontend/` contains the Next.js UI.
- `docker-compose.yml` starts PostgreSQL plus both services together.

## Run locally
1. `cd backend && composer install && cp .env.example .env && php artisan key:generate`
2. Configure `backend/.env` for your database.
3. `cd frontend && npm install`
4. Start the API and UI from their own folders, or use Docker if you prefer a single command.

## Useful commands
- Backend tests: `cd backend && php artisan test`
- Frontend lint: `cd frontend && npm run lint`
- Frontend build: `cd frontend && npm run build`

## Notes
- The app uses token-based auth through the API.
- The UI is built in React/Next.js, so there is no Blade layer in the application code.
