# 🚀 EigenGrid - Production Ready

## Resumen rápido

✅ WOL + Terminal SSH implementados y listos  
✅ Usuario "Arkana" creado  
✅ Configuración de Raspberry Pi como bastión lista  

---

## Ejecución en Producción (VPS)

### 1️⃣ Conectar al VPS

```bash
ssh eigengrid@145.223.94.180
cd /home/eigengrid/eigengrid
```

### 2️⃣ Crear usuario Arkana

```bash
cd backend
php artisan db:seed --class=ProductionUserSeeder
```

**Credenciales generadas:**
- Email: `eliseoalejandro.huetagoyena@gmail.com`
- Contraseña: `EigenGrid2024!`
- Nombre: `Arkana`

### 3️⃣ Configurar variables de entorno

Edita `/home/eigengrid/eigengrid/backend/.env` y reemplaza:

```bash
# Raspberry Pi (bastión)
WOL_BASTION_RPI_JUMP_HOST=145.223.94.180
WOL_BASTION_RPI_JUMP_USER=rpiwol
WOL_BASTION_RPI_HOST=localhost
WOL_BASTION_RPI_PORT=2222
WOL_BASTION_RPI_USER=root
WOL_BASTION_RPI_PASSWORD=<TU_CONTRASEÑA_RASPBERRY>

# Tu workstation (máquina target)
WOL_MACHINE_WS_MAC=a8:a1:59:27:c7:36
WOL_MACHINE_WS_SSH_HOST=localhost
WOL_MACHINE_WS_SSH_PORT=2222
WOL_MACHINE_WS_SSH_PASSWORD=<TU_CONTRASEÑA_WORKSTATION>

# SSH Bridge secret (generar con: openssl rand -hex 32)
SSH_BRIDGE_SECRET=<GENERAR_RANDOM>
SSH_BRIDGE_WS_URL=wss://homelab.inmobidev.com/ws
```

### 4️⃣ Recargar configuración y reiniciar

```bash
# En el backend
php artisan config:cache
php artisan route:cache

# Reiniciar todos los servicios
export PATH=$PATH:/usr/local/bin
pm2 restart eigengrid-frontend eigengrid-backend eigengrid-ssh-bridge
```

### 5️⃣ Verificar todo está correcto

```bash
# Ver logs del SSH Bridge
pm2 logs eigengrid-ssh-bridge

# Verificar usuario creado
php artisan tinker
User::all();
exit;
```

---

## Acceso en el navegador

Abre: **https://homelab.inmobidev.com**

Login:
- **Email:** `eliseoalejandro.huetagoyena@gmail.com`
- **Password:** `EigenGrid2024!`

---

## Flujo de Uso

### 1. Agregar máquina en el dashboard

- Click "+" para agregar host
- Name: `Workstation`
- Type: `Workstation`
- Agregar nodo con `machineId: workstation`

### 2. Encender máquina vía WOL

- Click botón Power (ícono de enchufe)
- Estado cambia a "waking" → envía Magic Packet a la Raspberry
- Raspberry ejecuta: `wakeonlan -i 192.168.1.255 a8:a1:59:27:c7:36`
- Workstation se enciende (demora 10-30 segundos)

### 3. Conectar via SSH

- Click botón "SSH" cuando máquina está ON
- Se abre terminal interactiva con xterm.js
- Conexión: Browser → VPS → Raspberry → Workstation
- Completamente seguro: credenciales nunca llegan al navegador

---

## Archivos Importantes

```
backend/
├── config/wol.php                          # Config de máquinas y bastiones
├── app/Services/WakeOnLanService.php       # Lógica WOL (SSH + Magic Packet)
├── app/Services/SshSessionService.php      # Token de sesión (60s, single-use)
├── app/Http/Controllers/WolController.php  # Endpoint POST /api/wol/{id}
├── app/Http/Controllers/SshSessionController.php # Endpoint SSH session
└── database/seeders/ProductionUserSeeder.php # Crea usuario Arkana

frontend/
├── ssh-bridge/index.js                     # WebSocket SSH bridge (Node.js)
├── app/dashboard/components/TerminalModal.tsx # Terminal xterm.js
├── app/dashboard/components/HostCard.tsx   # WOL + SSH buttons
└── app/dashboard/lib/api.ts                # Helpers de fetch

.github/workflows/deploy.yml                # CI/CD con ssh-bridge
```

---

## Arquitectura de Seguridad

```
┌─────────────────────┐
│   Browser (HTTPS)   │
│  homelab.inmobi...  │
└──────────┬──────────┘
           │
           ├─ POST /api/ssh/session {machine_id}
           │   ↓ (Sanctum Bearer Token)
           │ Laravel crea token opaco 60s
           │   ↓
           └─ WebSocket + token
              ↓
    ┌────────────────────┐
    │  SSH Bridge (Node) │ (puerto 4000, interno)
    │  Valida X-Bridge-Secret
    └────────┬───────────┘
             │
             ├─ SSH tunnel doble-hop:
             │  VPS:22 → Raspberry:2222 → Workstation:2222
             │
             └─ Shell interactivo ↔ xterm.js
```

**Credenciales SSH guardadas solo en el servidor (Laravel cache).  
El browser nunca las ve.**

---

## Troubleshooting

### "Magic packet sent" pero máquina no se enciende

1. Verifica que `wakeonlan` esté en la Raspberry:
   ```bash
   ssh -p 2222 root@localhost
   which wakeonlan
   # Si no: sudo apt install wakeonlan
   ```

2. Verifica que WOL esté habilitado en el BIOS de la workstation

3. Verifica la MAC address correcta:
   ```bash
   # En la workstation
   ip link show | grep ether
   ```

### Terminal SSH dice "Session expired"

El token dura 60 segundos. Si el navegador tarda mucho en conectar:
- Cierra la terminal modal
- Abre una nueva terminal SSH

### SSH Bridge no inicia

```bash
pm2 logs eigengrid-ssh-bridge
pm2 restart eigengrid-ssh-bridge
```

### Cambiar contraseña de usuario Arkana

```bash
cd /home/eigengrid/eigengrid/backend
php artisan tinker
$user = User::where('email', 'eliseoalejandro.huetagoyena@gmail.com')->first();
$user->password = Hash::make('new_password');
$user->save();
exit;
```

---

## Generar SSH_BRIDGE_SECRET

```bash
# En cualquier terminal (con openssl)
openssl rand -hex 32

# Ejemplo output:
# a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6

# Usa ese valor en .env como SSH_BRIDGE_SECRET
```

---

## Próximas mejoras opcionales

- [ ] Polling endpoint para detectar máquinas encendidas/apagadas automáticamente
- [ ] Múltiples usuarios con roles/permisos
- [ ] Historial de conexiones SSH
- [ ] Rate limiting para WOL (máximo 1 packet por minuto por máquina)
- [ ] Notificaciones cuando máquina se enciende
- [ ] Compatibilidad con SSH keys además de passwords

---

**Setup completado. Accede a https://homelab.inmobidev.com y disfruta! 🎉**
