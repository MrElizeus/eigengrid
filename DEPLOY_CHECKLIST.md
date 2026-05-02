# 📋 Deploy Checklist - Producción

## Pre-Deploy

- [ ] Verificar que todos los cambios están pusheados a `main`
- [ ] Confirmar que CI/CD pasó exitosamente en GitHub

---

## En el VPS

### Conexión

```bash
ssh eigengrid@145.223.94.180
cd /home/eigengrid/eigengrid
```

- [ ] Conectado al VPS

---

### Paso 1: Crear usuario Arkana

```bash
cd backend
php artisan db:seed --class=ProductionUserSeeder
```

**Output esperado:**
```
✓ User created/updated: eliseoalejandro.huetagoyena@gmail.com
✓ Name: Arkana
✓ Password: EigenGrid2024!
```

- [ ] Usuario creado

---

### Paso 2: Configurar credenciales

**Archivo a editar:** `/home/eigengrid/eigengrid/backend/.env`

```bash
nano /home/eigengrid/eigengrid/backend/.env
```

**Busca y reemplaza estos valores:**

```
# Antes:
WOL_BASTION_RPI_PASSWORD=<placeholder>
# Después:
WOL_BASTION_RPI_PASSWORD=<tu_contraseña_raspberry>
```

```
# Antes:
WOL_MACHINE_WS_SSH_PASSWORD=<placeholder>
# Después:
WOL_MACHINE_WS_SSH_PASSWORD=<tu_contraseña_workstation>
```

```
# Antes:
SSH_BRIDGE_SECRET=<placeholder>
# Después (generar con: openssl rand -hex 32):
SSH_BRIDGE_SECRET=<valor_aleatorio_64_chars>
```

**Guardar:** `Ctrl+O` → Enter → `Ctrl+X`

- [ ] Credenciales reemplazadas
- [ ] Archivo guardado

---

### Paso 3: Limpiar caché y reiniciar

```bash
# Limpiar caché de config
php artisan config:cache
php artisan route:cache

# Reiniciar servicios
export PATH=$PATH:/usr/local/bin
pm2 restart eigengrid-frontend eigengrid-backend eigengrid-ssh-bridge
```

**Output esperado:**
```
[PM2] Restarting app : eigengrid-frontend
[PM2] Restarting app : eigengrid-backend
[PM2] Restarting app : eigengrid-ssh-bridge
```

- [ ] Servicios reiniciados

---

### Paso 4: Verificar que todo funciona

#### Verificar usuario creado

```bash
php artisan tinker
User::all();
exit;
```

**Debería mostrar:**
```
Arkana Admin <eliseoalejandro.huetagoyena@gmail.com>
```

- [ ] Usuario verificado

#### Verificar SSH Bridge

```bash
pm2 logs eigengrid-ssh-bridge | head -20
```

**Debería mostrar:**
```
SSH Bridge listening on port 4000
Laravel API: http://127.0.0.1:8000
```

(Presiona `Ctrl+C` para salir de logs)

- [ ] SSH Bridge funcionando

#### Verificar conectividad Raspberry

```bash
# Intenta conectar a la Raspberry desde el VPS
ssh -p 2222 -o PubkeyAuthentication=no -o PreferredAuthentications=password root@localhost

# Debería pedir password de la Raspberry
# Escribe tu contraseña (no verá caracteres) y Enter
# Si funciona, verás el prompt de la Raspberry

# Desconecta con: exit
```

- [ ] Raspberry accesible vía SSH

---

### Paso 5: Acceso desde el navegador

Abre: **https://homelab.inmobidev.com**

**Login:**
- Email: `eliseoalejandro.huetagoyena@gmail.com`
- Password: `EigenGrid2024!`

- [ ] Login exitoso
- [ ] Dashboard visible
- [ ] Sin errores en la consola del navegador

---

### Paso 6: Verificar WOL y SSH Terminal (opcional)

Si quieres probar antes de encender la máquina real:

1. **Agregar host de prueba:**
   - Click "+" en el dashboard
   - Name: `Test Host`
   - Type: `Workstation`
   - Agregar nodo con `machineId: workstation`

2. **Probar WOL:**
   - Click botón Power
   - Debería cambiar a estado "waking"
   - Ver logs del backend:
     ```bash
     pm2 logs eigengrid-backend | grep -i "magic\|wol"
     ```

3. **Una vez máquina encendida, probar SSH:**
   - Click botón "SSH"
   - Debería abrir terminal interactiva
   - Probar comando: `whoami`

- [ ] WOL funciona
- [ ] SSH Terminal funciona (si máquina está on)

---

## Post-Deploy

### Monitoreo

```bash
# Ver estado de servicios
pm2 status

# Ver logs en tiempo real
pm2 logs

# Salir de logs: Ctrl+C
```

### Backup

```bash
# Hacer backup de la configuración
tar -czf /home/eigengrid/backup-$(date +%Y%m%d).tar.gz \
  /home/eigengrid/eigengrid/backend/.env \
  /home/eigengrid/eigengrid/frontend/ssh-bridge/.env
```

---

## ✅ Checklist Final

- [ ] Usuario Arkana creado
- [ ] Variables de entorno configuradas
- [ ] Servicios reiniciados
- [ ] Login funciona
- [ ] WOL funciona
- [ ] SSH Terminal funciona
- [ ] Logs no muestran errores
- [ ] Backup realizado

---

## 🚀 Ready for Production!

Si completaste todos los items ✅, **EigenGrid está listo en producción.**

Acceso: **https://homelab.inmobidev.com**  
Admin: **Arkana**  
Email: **eliseoalejandro.huetagoyena@gmail.com**

---

## Emergencies

Si algo falla:

**Ver qué salió mal:**
```bash
pm2 logs eigengrid-backend | tail -50
pm2 logs eigengrid-ssh-bridge | tail -50
```

**Reintentar configuración:**
```bash
cd /home/eigengrid/eigengrid/backend
php artisan config:cache
php artisan route:cache
pm2 restart eigengrid-frontend eigengrid-backend eigengrid-ssh-bridge
```

**Restaurar .env previo (si hiciste backup):**
```bash
cp /home/eigengrid/eigengrid/backend/.env.backup /home/eigengrid/eigengrid/backend/.env
```

---

¡Éxito! 🎉
