# Desplegar reserva-mcp en Railway

Railway porque: Postgres gestionado con un click, despliega directo desde
GitHub sin configurar CI, y la capa gratuita/hobby cubre de sobra un
proyecto de portfolio con tráfico bajo.

## 1. Subir el proyecto a GitHub

```bash
cd reserva-mcp
git init
git add .
git commit -m "reserva-mcp: servidor MCP de reservas con observabilidad y tests de concurrencia"
```

Crea un repo nuevo en https://github.com/new (público, se llama `reserva-mcp`
o el nombre que prefieras) y luego:

```bash
git remote add origin https://github.com/TU_USUARIO/reserva-mcp.git
git branch -M main
git push -u origin main
```

## 2. Crear el proyecto en Railway

1. Ve a https://railway.app y entra con tu cuenta de GitHub
2. **New Project → Deploy from GitHub repo** → elige `reserva-mcp`
3. Railway detecta el `Dockerfile` automáticamente (por el `railway.json`)

## 3. Añadir Postgres

1. En el mismo proyecto de Railway: **+ New → Database → Add PostgreSQL**
2. Railway crea la base de datos y expone una variable `DATABASE_URL`
   automáticamente dentro del proyecto

## 4. Conectar el servicio con la base de datos

En el servicio `reserva-mcp` (no en el de Postgres) → pestaña **Variables**:

```
DATABASE_URL = ${{Postgres.DATABASE_URL}}
MCP_PORT = 3002
ALLOWED_ORIGIN = *
```

La sintaxis `${{Postgres.DATABASE_URL}}` hace que Railway inyecte
automáticamente la URL de conexión del servicio de Postgres que acabas de
crear — no la copies a mano, así si Railway rota credenciales no se rompe.

## 5. Migrar y sembrar la base de datos en Railway (una sola vez)

Instala la CLI de Railway si no la tienes:

```bash
npm install -g @railway/cli
railway login
railway link   # selecciona tu proyecto reserva-mcp
```

Ejecuta la migración y el seed **contra la base de datos de Railway**,
desde tu máquina, usando las variables de entorno del proyecto remoto:

```bash
railway run npm run db:migrate
railway run npm run db:seed
```

## 6. Verificar que está vivo

Railway te da una URL pública en la pestaña **Settings → Networking →
Generate Domain** del servicio. Con esa URL:

```bash
curl https://TU-SERVICIO.up.railway.app/health
# esperado: {"status":"ok"}
```

## 7. Probarlo con un cliente MCP real contra la URL en producción

Desde tu máquina (fuera de Railway), con el SDK de MCP instalado:

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const transport = new StreamableHTTPClientTransport(
  new URL("https://TU-SERVICIO.up.railway.app/mcp")
);
const client = new Client({ name: "prod-check", version: "1.0.0" });
await client.connect(transport);
console.log(await client.listTools());
```

Si ves las 5 herramientas listadas, el despliegue funciona de verdad, no
solo el health check.

## 8. Conectarlo desde Claude (opcional pero muy recomendable para el video del portfolio)

En claude.ai o Claude Desktop: **Settings → Connectors → Add custom
connector**, y pega la URL `https://TU-SERVICIO.up.railway.app/mcp`. A
partir de ahí puedes preguntarle a Claude cosas como *"¿tienes mesa para 4
mañana a las 21:00?"* y verlo llamar a tus herramientas en producción —
esto es exactamente lo que deberías grabar para el video del portfolio.

## Notas honestas

- El rate limiting vive en memoria del proceso (ver README principal) —
  con una sola réplica en Railway esto funciona bien; si escalas a más de
  una instancia, deja de ser correcto y hay que moverlo a Redis.
- Railway hiberna los servicios gratuitos tras un rato de inactividad en
  el plan hobby — la primera petición tras la hibernación puede tardar
  unos segundos en responder. No es un bug, es normal en capa gratuita.
