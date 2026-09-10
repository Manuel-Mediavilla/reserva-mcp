# reserva-mcp — Servidor MCP de reservas de restaurante

## Qué es

Un servidor [MCP](https://modelcontextprotocol.io) (Model Context Protocol,
el estándar abierto de Anthropic que en 2026 también adoptan OpenAI, Google
y Microsoft) que expone la gestión de reservas de un restaurante como
**herramientas tipadas** que cualquier agente de IA puede usar: Claude
Desktop, Claude Code, Cursor, o un agente propio construido sobre la API de
Anthropic. No es un chatbot envuelto en un prompt — es la capa de
integración estándar que un agente necesita para *actuar* sobre un negocio
real, no solo hablar de él.

## Demo

- Conexión por stdio (local, Claude Desktop/Code): ver [Cómo probarlo](#cómo-probarlo-con-claude-desktop)
- Servidor HTTP desplegado: _pendiente_
- Video de uso desde Claude Desktop: _pendiente_

## Las 5 herramientas

| Herramienta | Qué hace | Tipo |
|---|---|---|
| `check_availability` | Mesas libres para fecha/hora + nº de comensales | solo lectura |
| `create_reservation` | Reserva una mesa (elige la de mejor ajuste automáticamente) | acción |
| `cancel_reservation` | Cancela una reserva existente | acción |
| `get_reservation` | Busca por ID o por teléfono del cliente | solo lectura |
| `list_today_reservations` | Todas las reservas confirmadas de un día (uso admin) | solo lectura |

## Por qué lo construí así

- **El problema de negocio real no es el CRUD, es la concurrencia.** Dos
  clientes pidiendo la misma mesa a la vez es el caso que de verdad importa
  en un sistema de reservas. Por eso la garantía contra dobles reservas
  vive en la propia base de datos (`EXCLUDE USING gist` sobre el rango de
  tiempo de cada mesa), no en una validación de aplicación que una carrera
  de peticiones podría saltarse.
- **Cada tool-call se registra** (`tool_call_logs`): nombre, argumentos,
  éxito/fallo, latencia, cliente. Esto es la base de datos que un panel de
  observabilidad de agentes necesitaría — la pieza que el mercado de
  contratación de IA pide explícitamente en 2026 y que casi ningún
  portfolio junior tiene.
- **Rate limiting por cliente MCP**, para que un agente con un bug (o un
  bucle de reintentos mal hecho) no pueda machacar el servidor.
- **Dos transportes**: stdio para uso local (Claude Desktop/Code, lo que
  se prueba en desarrollo) y Streamable HTTP para despliegue remoto — el
  mismo servidor, dos formas de conectarse, tal como recomienda el propio
  estándar MCP para pasar de "experimento local" a "servicio en producción".

## Dos fallos reales encontrados construyendo esto (y cómo los arreglé)

Esta sección es, a propósito, la más importante del README — no por
transparencia performativa, sino porque es la prueba de que el proyecto se
probó de verdad contra el protocolo real, no solo se compiló.

**1. Bajo concurrencia real, la mayoría de las reservas fallaban aunque
hubiera mesas libres.**
Al lanzar 8 peticiones de reserva simultáneas para la misma franja, solo
**1 de 8** tenía éxito — a pesar de haber 5 mesas con capacidad suficiente.
La causa: el código elegía siempre "la mesa más ajustada" (`available[0]`)
y, si esa mesa concreta perdía la carrera contra otro cliente milisegundos
antes, fallaba directamente en vez de probar con la siguiente candidata de
la lista. **Arreglado** añadiendo reintento secuencial sobre las mesas
candidatas: si una pierde la carrera (error `23P01`, exclusion violation
de Postgres), se prueba la siguiente antes de rendirse. Tras el fix, la
misma prueba de 8 peticiones concurrentes da **5 de 8 éxitos** — el máximo
matemáticamente posible con 5 mesas — con **0 dobles reservas** en ambos
casos. La prueba que lo demuestra vive en `eval/run-eval.ts`
(`concurrencia_no_permite_doble_reserva`) y se puede volver a correr con
`npm run eval`.

**2. El log de observabilidad tiene un punto ciego: no ve los rechazos de
esquema.** Cuando el cliente MCP envía un argumento con formato inválido
(ej. una fecha sin zona horaria), el propio SDK de MCP valida contra el
esquema Zod y rechaza la llamada **antes** de que el código de la
herramienta —y por tanto el logger— llegue a ejecutarse. El resultado es
correcto de cara al cliente (`isError: true`), pero esas llamadas no
quedan registradas en `tool_call_logs`, así que hoy no hay forma de saber
"cuántas veces un agente mandó argumentos mal formados". Lo documento como
limitación conocida en vez de esconderlo: **arreglarlo requeriría
interceptar a nivel del `Server` subyacente de MCP, no de `registerTool`**,
que es el siguiente paso si este proyecto avanza a producción.

## Cómo probarlo con Claude Desktop

```bash
npm install
cp .env.example .env   # y rellena DATABASE_URL
npm run db:migrate
npm run db:seed
```

Añade esto a la configuración de Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "reservas-demo": {
      "command": "npx",
      "args": ["tsx", "/ruta/absoluta/a/reserva-mcp/src/server.ts"]
    }
  }
}
```

Reinicia Claude Desktop y pregúntale algo como *"¿tienes mesa para 4
personas mañana a las 21:00?"* — Claude debería llamar a
`check_availability` solo, sin que se lo indiques explícitamente.

## Cómo correr el harness de evaluación

```bash
npm run eval
```

Levanta el servidor real por stdio, conecta un cliente MCP real (mismo
protocolo que usaría Claude Desktop) y ejecuta 5 casos deterministas,
incluida la prueba de concurrencia de 8 peticiones simultáneas. Al final
imprime latencia media y p95 por herramienta, calculadas directamente
desde `tool_call_logs`.

**Nota honesta:** este harness no usa un LLM real (no había credenciales
de API disponibles en el entorno donde lo construí) — prueba que el
protocolo y la lógica de negocio son correctos, no que un modelo elige
bien la herramienta a partir de lenguaje natural. Para esa evaluación, el
siguiente paso es apuntar este mismo cliente a la API de Anthropic con
tool-use habilitado, correr N prompts en lenguaje natural, y medir la
tasa de acierto en la selección de herramienta — la métrica que de verdad
piden los roles de "AI Tooling Engineer" en 2026.

## Stack

- TypeScript (strict) + `@modelcontextprotocol/sdk` (SDK oficial de Anthropic)
- PostgreSQL con `EXCLUDE USING gist` para concurrencia real, sin ORM
- Zod para los esquemas de entrada de cada herramienta
- Express + Streamable HTTP para el transporte remoto
- Vitest para la lógica pura (rate limiter); el harness de `eval/` cubre la integración end-to-end

## Qué haría distinto en producción

- Persistir el rate limiting en Redis, no en memoria del proceso —
  necesario en cuanto haya más de una réplica del servidor HTTP.
- Cerrar el punto ciego de logging de rechazos de esquema (ver arriba).
- Autenticación real por servidor MCP (hoy cualquiera que conozca la URL
  del transporte HTTP puede conectarse) — OAuth es parte del propio
  estándar MCP y está pendiente de integrar.
- Un tercer transporte SSE quedó fuera de alcance deliberadamente: el SDK
  lo soporta, pero Streamable HTTP ya cubre el caso de uso remoto y añadir
  un tercer camino de conexión no aportaba señal nueva para este proyecto.
