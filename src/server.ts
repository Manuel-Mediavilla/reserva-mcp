import "dotenv/config";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createReservaServer } from "./mcpServerFactory.js";

async function main() {
  const server = createReservaServer("stdio-local");
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Nunca escribir a stdout fuera del protocolo MCP: stdout es el canal
  // de mensajes JSON-RPC. Los logs de diagnóstico van a stderr.
  console.error("[reserva-mcp] servidor stdio listo, esperando cliente MCP...");
}

main().catch((err) => {
  console.error("[reserva-mcp] error fatal:", err);
  process.exit(1);
});
