import { pool } from "../db/pool.js";

interface LogParams {
  toolName: string;
  args: unknown;
  success: boolean;
  errorMessage?: string;
  latencyMs: number;
  clientId?: string;
}

/**
 * Registra cada llamada a herramienta con su resultado y latencia.
 * Esta tabla es la base de datos que un panel de observabilidad
 * (AgentOps) consultaría para calcular tasa de éxito, coste y
 * detectar patrones de fallo -- la métrica que el mercado pide
 * explícitamente para portfolios de IA en 2026.
 *
 * Nunca lanza: un fallo al loguear no debe tumbar la respuesta real
 * de la herramienta al cliente MCP.
 */
export async function logToolCall(params: LogParams): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO tool_call_logs (tool_name, arguments, success, error_message, latency_ms, client_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        params.toolName,
        JSON.stringify(params.args),
        params.success,
        params.errorMessage ?? null,
        params.latencyMs,
        params.clientId ?? null,
      ]
    );
  } catch (err) {
    console.error("[toolLogger] no se pudo registrar la llamada", err);
  }
}

/**
 * Envuelve un handler de herramienta para medir latencia y loguear
 * automáticamente éxito/fallo, sin repetir este código en cada tool.
 */
export function withLogging<Args, Result>(
  toolName: string,
  handler: (args: Args) => Promise<Result>
) {
  return async (args: Args): Promise<Result> => {
    const start = Date.now();
    try {
      const result = await handler(args);
      await logToolCall({
        toolName,
        args,
        success: true,
        latencyMs: Date.now() - start,
      });
      return result;
    } catch (err) {
      await logToolCall({
        toolName,
        args,
        success: false,
        errorMessage: err instanceof Error ? err.message : String(err),
        latencyMs: Date.now() - start,
      });
      throw err;
    }
  };
}
