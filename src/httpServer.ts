import "dotenv/config";
import express from "express";
import cors from "cors";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createReservaServer } from "./mcpServerFactory.js";

const app = express();
app.use(cors({ origin: process.env.ALLOWED_ORIGIN?.split(",") ?? "*", exposedHeaders: ["mcp-session-id"] }));
app.use(express.json());

app.get("/health", (_req, res) => res.json({ status: "ok" }));

// Una sesión = un cliente MCP conectado = un servidor + transporte propio.
// Así el rate limiting y el logging distinguen clientes reales entre sí,
// en vez de compartir un único estado global entre todos los usuarios.
const sessions = new Map<string, StreamableHTTPServerTransport>();

app.post("/mcp", async (req, res) => {
  const sessionIdHeader = req.header("mcp-session-id");

  let transport = sessionIdHeader ? sessions.get(sessionIdHeader) : undefined;

  if (!transport) {
    const newSessionId = randomUUID();
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => newSessionId,
      onsessioninitialized: (id) => {
        sessions.set(id, transport!);
      },
    });
    transport.onclose = () => {
      if (transport?.sessionId) sessions.delete(transport.sessionId);
    };

    const server = createReservaServer(newSessionId);
    await server.connect(transport);
  }

  await transport.handleRequest(req, res, req.body);
});

app.get("/mcp", async (req, res) => {
  const sessionId = req.header("mcp-session-id");
  const transport = sessionId ? sessions.get(sessionId) : undefined;
  if (!transport) {
    res.status(400).json({ error: "Sesión MCP no encontrada" });
    return;
  }
  await transport.handleRequest(req, res);
});

const PORT = Number(process.env.PORT) || Number(process.env.MCP_PORT) || 3002;
app.listen(PORT, () => {
  console.log(`[reserva-mcp] servidor HTTP escuchando en http://localhost:${PORT}/mcp`);
});
