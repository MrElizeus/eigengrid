# Production Setup - EigenGrid

## Paso 1: Crear usuario de producción

Conéctate al VPS y ejecuta:

```bash
ssh eigengrid@145.223.94.180
cd /home/eigengrid/eigengrid/backend

# Ejecuta el seeder para crear el usuario
php artisan db:seed --class=ProductionUserSeeder
```

**Credenciales de acceso (producción):**
- **Email:** `eliseoalejandro.huetagoyena@gmail.com`
- **Contraseña:** `EigenGrid2024!`

---

## Paso 2: Configurar Raspberry Pi como bastión

### En el VPS (`/home/eigengrid/eigengrid/backend/.env`)

Agrega o actualiza estas variables:

```bash
# Bastion - Raspberry Pi
WOL_BASTION_RPI_JUMP_HOST=145.223.94.180
WOL_BASTION_RPI_JUMP_USER=rpiwol
WOL_BASTION_RPI_HOST=localhost
WOL_BASTION_RPI_PORT=2222
WOL_BASTION_RPI_USER=root
WOL_BASTION_RPI_AUTH=password
WOL_BASTION_RPI_PASSWORD=your_actual_raspberry_password

# Máquina target (tu workstation)
WOL_MACHINE_WS_BASTION=rpi-home
WOL_MACHINE_WS_MAC=a8:a1:59:27:c7:36
WOL_MACHINE_WS_BROADCAST=192.168.1.255
WOL_MACHINE_WS_SSH_HOST=localhost
WOL_MACHINE_WS_SSH_PORT=2222
WOL_MACHINE_WS_SSH_USER=root
WOL_MACHINE_WS_SSH_PASSWORD=your_actual_machine_password

# SSH Bridge secret (generar string aleatorio de 64 chars)
SSH_BRIDGE_SECRET=your_random_64_char_secret_here
SSH_BRIDGE_WS_URL=wss://homelab.inmobidev.com/ws
```

### Reemplazar los valores actuales:

```bash
# En el VPS:
cd /home/eigengrid/eigengrid/backend

# Edita el .env con tu editor favorito (nano, vim, etc.)
nano .env

# Guarda (Ctrl+O, Enter, Ctrl+X si es nano)

# Limpia la caché de configuración
php artisan config:cache

# Reinicia los servicios
export PATH=$PATH:/usr/local/bin
pm2 restart eigengrid-frontend eigengrid-backend eigengrid-ssh-bridge
```

---

## Paso 3: Verificar configuración

### Comprobar que el user fue creado:

```bash
cd /home/eigengrid/eigengrid/backend
php artisan tinker
User::all();
# Debería mostrar tu usuario con el email
```

### Comprobar que la Raspberry está accesible:

```bash
# Desde el VPS, prueba conectarte a la Raspberry vía SSH
ssh -p 2222 -o PubkeyAuthentication=no -o PreferredAuthentications=password rpiwol@localhost

# Si funciona, presiona Ctrl+D para desconectar
# Luego prueba desde la Raspberry misma:
ssh root@localhost -p 2222
# (debería permitir login con tu contraseña de la workstation)
```

---

## Paso 4: Probar WOL desde homelab.inmobidev.com

1. Abre https://homelab.inmobidev.com
2. Login con:
   - Email: `eliseoalejandro.huetagoyena@gmail.com`
   - Password: `EigenGrid2024!`
3. En el dashboard, agrega un host con:
   - Name: `Workstation`
   - Type: `Workstation`
4. Edita el nodo y agrega:
   - Machine ID: `workstation`
   - MAC: `a8:a1:59:27:c7:36`
5. Click en el botón Power → debería enviar Magic Packet
6. Una vez encendida, click en SSH → debería abrir terminal interactiva

---

## Configuración de ejemplo completa

Si necesitas replicar esto en otro bastión o máquina, la estructura en `backend/config/wol.php` es:

```php
'bastions' => [
    'my-bastion' => [
        'jump_host' => 'tu_vps_publico.com',    // IP del VPS público
        'jump_user' => 'usuario_vps',
        'host' => 'localhost',                  // Desde perspectiva del VPS
        'port' => 2222,                         // Puerto SSH del bastión
        'user' => 'root',
        'auth' => 'password',
        'password' => env('WOL_BASTION_PASSWORD'),
    ],
],

'machines' => [
    'my-machine' => [
        'bastion' => 'my-bastion',
        'mac' => 'AA:BB:CC:DD:EE:FF',
        'broadcast' => '192.168.1.255',
        'ssh_host' => 'localhost',              // Desde perspectiva del bastión
        'ssh_port' => 2222,
        'ssh_user' => 'root',
        'ssh_auth' => 'password',
        'ssh_password' => env('WOL_MACHINE_PASSWORD'),
    ],
],
```

---

## Troubleshooting

### Error: "Magic packet sent" pero la máquina no se enciende

1. Verifica que `wakeonlan` esté instalado en la Raspberry:
   ```bash
   ssh -p 2222 root@localhost
   which wakeonlan
   # Si no existe: sudo apt install wakeonlan
   ```

2. Verifica la MAC address:
   ```bash
   # En la máquina a encender
   ip link show | grep ether
   ```

3. Verifica que WOL esté habilitado en el BIOS de la máquina

### Error: "Session expired" en el terminal

El token de sesión SSH dura 60 segundos. Si demora mucho en conectar, abre una nueva terminal.

### El SSH Bridge no inicia

```bash
# En el VPS, verifica logs:
pm2 logs eigengrid-ssh-bridge

# Reinicia:
pm2 restart eigengrid-ssh-bridge

# O arranca manualmente para ver errores:
cd /home/eigengrid/eigengrid/frontend/ssh-bridge
node index.js
```

---

## Cambiar contraseña del usuario

Si necesitas cambiar la contraseña después:

```bash
cd /home/eigengrid/eigengrid/backend

php artisan tinker
$user = User::where('email', 'eliseoalejandro.huetagoyena@gmail.com')->first();
$user->password = Hash::make('new_password_here');
$user->save();
exit;
```
