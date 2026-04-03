# Backend

Laravel powers the EigenGrid API in this folder.

## Scope
- Authentication endpoints live in `routes/api.php`.
- Database migrations and models live under the usual Laravel directories.
- Blade views and web routes are intentionally not part of this app layer.

## Commands
- Install dependencies: `composer install`
- Prepare env: `cp .env.example .env && php artisan key:generate`
- Run tests: `php artisan test`
- Serve locally: `php artisan serve`
