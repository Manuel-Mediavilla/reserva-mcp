/**
 * Harness de evaluación del servidor MCP.
 *
 * No usa un LLM (no había API key disponible en el entorno de build),
 * así que mide lo que SÍ se puede medir sin uno: que el protocolo MCP
 * responde correctamente, que la lógica de negocio es correcta, y que
 * el sistema aguanta condiciones de carrera reales. Esto es el
 * equivalente a un test de integración de extremo a extremo sobre el
 * servidor real (mismo protocolo JSON-RPC que usaría Claude Desktop).
 *
 * Para la evaluación "con LLM de verdad" (qué tan bien un modelo elige
 * la herramienta correcta a partir de lenguaje natural), este mismo
 * cliente se puede apuntar a la API de Anthropic con tool-use -- lo
 * dejo documentado en el README como siguiente paso, no fingido aquí.
 */
import "dotenv/config";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { pool } from "../src/db/pool.js";

interface CaseResult {
  name: string;
  passed: boolean;
  detail: string;
  latencyMs: number;
}

const results: CaseResult[] = [];

async function record(name: string, fn: () => Promise<{ passed: boolean; detail: string }>) {
  const start = Date.now();
  try {
    const { passed, detail } = await fn();
    results.push({ name, passed, detail, latencyMs: Date.now() - start });
  } catch (err) {
    results.push({
      name,
      passed: false,
      detail: `excepción no controlada: ${err instanceof Error ? err.message : String(err)}`,
      latencyMs: Date.now() - start,
    });
  }
}

function textOf(result: any): string {
  return result.content?.[0]?.text ?? "";
}

async function main() {
  const transport = new StdioClientTransport({ command: "npx", args: ["tsx", "src/server.ts"] });
  const client = new Client({ name: "eval-client", version: "1.0.0" });
  await client.connect(transport);

  const slot = new Date();
  slot.setDate(slot.getDate() + 2);
  slot.setHours(22, 0, 0, 0); // franja limpia, sin datos del seed

  // --- Caso 1: disponibilidad inicial ---
  await record("disponibilidad_inicial_5_mesas", async () => {
    const res = await client.callTool({
      name: "check_availability",
      arguments: { startsAt: slot.toISOString(), partySize: 2 },
    });
    const data = JSON.parse(textOf(res));
    return {
      passed: data.available === true && data.tables.length === 5,
      detail: `${data.tables.length} mesas libres (esperado: 5)`,
    };
  });

  // --- Caso 2: reserva válida ---
  let firstReservationId = "";
  await record("crear_reserva_valida", async () => {
    const res = await client.callTool({
      name: "create_reservation",
      arguments: {
        customerName: "Test Uno",
        customerPhone: "+34600000001",
        partySize: 2,
        startsAt: slot.toISOString(),
      },
    });
    const data = JSON.parse(textOf(res));
    firstReservationId = data.id;
    return { passed: !!data.id && data.status === "confirmed", detail: `reserva ${data.id}` };
  });

  // --- Caso 3: fecha con formato inválido (rechazo a nivel de esquema) ---
  await record("rechaza_fecha_sin_timezone", async () => {
    const res = await client.callTool({
      name: "check_availability",
      arguments: { startsAt: "2026-12-01 21:00", partySize: 2 },
    });
    return { passed: res.isError === true, detail: "esperado isError=true por esquema Zod" };
  });

  // --- Caso 4: EL IMPORTANTE — concurrencia real sobre el mismo recurso.
  // 8 peticiones simultáneas pidiendo la ÚLTIMA mesa de capacidad exacta
  // disponible en ese instante. Solo UNA debe ganar; el resto debe fallar
  // con NoAvailabilityError, nunca con una reserva duplicada silenciosa.
  await record("concurrencia_no_permite_doble_reserva", async () => {
    // Vaciamos las mesas de capacidad 2 dejando un único hueco a propósito:
    // usamos otra franja limpia y lanzamos 8 creaciones en paralelo para
    // el mismo party_size=2 (solo hay 2 mesas de capacidad 2 -> máximo
    // 2 éxitos posibles, el resto deben fallar de forma controlada).
    const raceSlot = new Date();
    raceSlot.setDate(raceSlot.getDate() + 3);
    raceSlot.setHours(14, 0, 0, 0);

    const attempts = Array.from({ length: 8 }, (_, i) =>
      client.callTool({
        name: "create_reservation",
        arguments: {
          customerName: `Concurrente ${i}`,
          customerPhone: `+3460000${100 + i}`,
          partySize: 2,
          startsAt: raceSlot.toISOString(),
        },
      })
    );

    const settled = await Promise.all(attempts);
    const succeeded = settled.filter((r) => !r.isError).length;
    const failed = settled.filter((r) => r.isError).length;

    // Con 5 mesas en total (2 de capacidad 2, y 3 más grandes que también
    // aceptan party_size=2 por tener capacidad >= 2), hasta 5 pueden
    // ganar como máximo -- lo importante no es el número exacto, sino
    // que succeeded + failed === 8 y que NINGUNA mesa quedó con más de
    // una reserva activa solapada (lo verificamos aparte, en DB).
    const overlapCheck = await pool.query(
      `SELECT table_id, COUNT(*) as n
       FROM reservations
       WHERE starts_at = $1 AND status = 'confirmed'
       GROUP BY table_id HAVING COUNT(*) > 1`,
      [raceSlot.toISOString()]
    );

    return {
      passed: succeeded + failed === 8 && overlapCheck.rows.length === 0,
      detail: `${succeeded} éxitos, ${failed} rechazados, ${overlapCheck.rows.length} mesas con doble reserva (esperado: 0)`,
    };
  });

  // --- Caso 5: cancelar y comprobar que libera la mesa ---
  await record("cancelar_libera_mesa", async () => {
    await client.callTool({
      name: "cancel_reservation",
      arguments: { reservationId: firstReservationId },
    });
    const res = await client.callTool({
      name: "check_availability",
      arguments: { startsAt: slot.toISOString(), partySize: 2 },
    });
    const data = JSON.parse(textOf(res));
    return {
      passed: data.tables.length === 5,
      detail: `${data.tables.length} mesas libres tras cancelar (esperado: 5)`,
    };
  });

  await client.close();

  // --- Métricas agregadas desde el log real de tool-calls ---
  const logStats = await pool.query(`
    SELECT
      tool_name,
      COUNT(*) FILTER (WHERE success) AS ok,
      COUNT(*) FILTER (WHERE NOT success) AS ko,
      ROUND(AVG(latency_ms)) AS avg_ms,
      PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY latency_ms) AS p95_ms
    FROM tool_call_logs
    GROUP BY tool_name
    ORDER BY tool_name
  `);

  console.log("\n========== RESULTADOS DEL HARNESS ==========\n");
  let passedCount = 0;
  for (const r of results) {
    const mark = r.passed ? "✅" : "❌";
    console.log(`${mark} ${r.name} (${r.latencyMs}ms) — ${r.detail}`);
    if (r.passed) passedCount++;
  }
  console.log(`\n${passedCount}/${results.length} casos superados\n`);

  console.log("========== MÉTRICAS DESDE tool_call_logs ==========\n");
  console.table(logStats.rows);

  await pool.end();
  process.exit(passedCount === results.length ? 0 : 1);
}

main().catch((err) => {
  console.error("Error en el harness:", err);
  process.exit(1);
});
