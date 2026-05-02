# CLAUDE.md — EigenGrid

Web app para gestión de datos con Laravel API y frontend Next.js.

## Stack Tecnológico

- **Backend:** Laravel 13 / PHP 8.3 / PostgreSQL
- **Frontend:** React 19 + Next.js 16 + TypeScript + Tailwind CSS 4
- **Database:** PostgreSQL 15
- **Tests:** PHPUnit 12.5 (backend)
- **Linting:** Laravel Pint (PHP) · ESLint (React)
- **CI/CD:** GitHub Actions

## Estructura de Proyecto

```
├── backend/          # Laravel API REST
│   ├── app/          # Controllers, Models, Services
│   ├── database/     # Migrations, Seeders
│   ├── tests/        # PHPUnit tests
│   ├── composer.json
│   └── .env.example
├── frontend/         # Next.js React UI
│   ├── src/          # Pages, components
│   ├── package.json
│   └── tsconfig.json
├── docker-compose.yml # Local dev environment
└── .github/workflows # CI/CD pipelines
```

## Comandos de Desarrollo

```bash
# Setup initial
cd backend && composer install && cp .env.example .env && php artisan key:generate
cd frontend && npm install

# Development (from project root)
composer run dev

# Backend tests
cd backend && composer run test

# Frontend lint
cd frontend && npm run lint

# Frontend build
cd frontend && npm run build

# Database
cd backend && php artisan migrate
cd backend && php artisan migrate:fresh --seed

# Docker (starts both services + PostgreSQL)
docker-compose up
```

## Convenciones del Proyecto

### Backend
- Laravel 13 framework (latest stable)
- Sanctum para autenticación API token-based
- Form Requests para validación
- Services layer para lógica de negocio
- PHPUnit para tests

### Frontend
- Next.js App Router
- React 19 con TypeScript
- Tailwind CSS 4 (utility-first)
- ESLint para linting

### Database
- PostgreSQL 15
- Migrations versionadas
- UUIDs o auto-increment IDs (según modelo)

## Wake-on-LAN & SSH Terminal

### Configuración de Máquinas y Bastiones

La plataforma soporta WOL (Magic Packet) y acceso SSH interactivo vía web. Configurable en `backend/config/wol.php`:

```php
'machines' => [
    'workstation' => [
        'bastion' => 'rpi-home',          // Bastión a usar
        'mac' => 'a8:a1:59:27:c7:36',     // MAC para WOL
        'broadcast' => '192.168.1.255',
        'ssh_host' => 'localhost',        // Host SSH (visto desde bastión)
        'ssh_port' => 2222,
        'ssh_user' => 'root',
        'ssh_auth' => 'password',         // 'password' | 'key'
        'ssh_password' => env('...'),
    ],
],
```

### Flujo de WOL
1. Frontend: click botón "Power" → `POST /api/wol/{machineId}`
2. Backend: autentica con bastión vía phpseclib (SSH)
3. Bastión: ejecuta `wakeonlan -i {broadcast} {mac}`
4. Frontend: muestra estado "waking" hasta que máquina esté en línea

### Terminal SSH en el Browser
- Frontend solicita sesión: `POST /api/ssh/session { machine_id }`
- Backend genera token opaco (60s, single-use), retorna URL WebSocket
- Frontend conecta: `WebSocket(wss://homelab.inmobidev.com/ws?token=XXX)`
- SSH Bridge (Node.js en puerto 4000, interno) valida token, abre túneles:
  - VPS (jump host) → Bastión (RPi) → Máquina target
- Terminal xterm.js en el navegador, bidireccional

### Seguridad
- Credenciales SSH **nunca** viajan al browser
- Token de sesión es único y de una sola use (se borra después de consumir)
- Middleware `bridge.secret` protege el endpoint de credenciales
- SSH Bridge valida con `X-Bridge-Secret` header

## Entorno de Producción (VPS)

### Ubicación
```
ssh eigengrid@145.223.94.180
/home/eigengrid/eigengrid/
```

### Dominio
- **homelab.inmobidev.com** (HTTPS)

### Servicios
- **Backend:** PHP 8.3 con pm2 (eigengrid-backend)
- **Frontend:** Node.js con pm2 (eigengrid-frontend)
- **SSH Bridge:** Node.js con pm2 (eigengrid-ssh-bridge) — puerto 4000 interno
- **Database:** PostgreSQL 15

## CI/CD

- **GitHub Actions** dispara deploy en cada push a `main`
- Workflow: `.github/workflows/deploy.yml`
- Deploy automatizado:
  1. `git pull origin main`
  2. Backend: `composer install --no-dev`, migrations, cache
  3. Frontend: `npm install`, build
  4. Reinicia servicios pm2: `eigengrid-frontend` y `eigengrid-backend`

### Variables de entorno requeridas (GitHub Secrets)
- `VPS_HOST` — IP/dominio del VPS
- `VPS_USER` — usuario SSH
- `SSH_PRIVATE_KEY` — clave privada SSH

## Notas Importantes

- Token-based authentication en la API (Laravel Sanctum)
- No hay Blade, todo es JSON API + Next.js frontend
- Docker Compose para desarrollo local incluye PostgreSQL
- Base de datos en producción: PostgreSQL (no SQLite)

## Enlaces Útiles

- README.md — Setup rápido y comandos básicos
- docker-compose.yml — Configuración de servicios locales
