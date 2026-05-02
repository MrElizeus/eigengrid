#!/bin/bash

# EigenGrid Production Setup Script
# Ejecutar en el VPS como: bash setup-production.sh

set -e

cd /home/eigengrid/eigengrid

echo "========================================="
echo "EigenGrid Production Setup"
echo "========================================="
echo ""

# Step 1: Create application user
echo "📝 Creating application user..."
cd backend

php artisan db:seed --class=ProductionUserSeeder

echo "✓ User created!"
echo ""
echo "Credenciales:"
echo "  Email:    eliseoalejandro.huetagoyena@gmail.com"
echo "  Password: EigenGrid2024!"
echo ""

# Step 2: Instructions for configuration
echo "========================================="
echo "⚙️  Próximo paso: Configurar .env"
echo "========================================="
echo ""
echo "Edita: /home/eigengrid/eigengrid/backend/.env"
echo ""
echo "Reemplaza estos valores con tus credenciales reales:"
echo ""
echo "1. Contraseña de la Raspberry (bastión):"
echo "   WOL_BASTION_RPI_PASSWORD=<tu_contraseña_raspberry>"
echo ""
echo "2. Contraseña de la máquina target (workstation):"
echo "   WOL_MACHINE_WS_SSH_PASSWORD=<tu_contraseña_workstation>"
echo ""
echo "3. Secret para el SSH Bridge (generar con):"
echo "   openssl rand -hex 32"
echo "   SSH_BRIDGE_SECRET=<tu_valor_aqui>"
echo ""

# Step 3: Quick verify
echo "========================================="
echo "✅ Setup completado"
echo "========================================="
echo ""
echo "Pasos manuales necesarios:"
echo "1. Edita .env con tus credenciales"
echo "2. Ejecuta: php artisan config:cache"
echo "3. Ejecuta: pm2 restart eigengrid-frontend eigengrid-backend eigengrid-ssh-bridge"
echo ""
