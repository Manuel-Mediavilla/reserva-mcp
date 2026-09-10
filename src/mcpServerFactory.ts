import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  findAvailableTables,
  createReservation,
  cancelReservation,
  getReservation,
  listReservationsForDay,
  NoAvailabilityError,
  ReservationNotFoundError,
} from "./domain/reservations.service.js";
import { withLogging } from "./logging/toolLogger.js";
import { checkRateLimit, RateLimitExceededError } from "./rateLimiter.js";

const RESTAURANT_SLUG = "demo"; // servidor de un único restaurante para el alcance de este proyecto

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function fail(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

/**
 * Crea una instancia nueva de McpServer con las 5 herramientas de
 * reservas registradas. `clientId` identifica al cliente MCP conectado
 * (usado para rate limiting y para el log de tool-calls) -- en stdio
 * es fijo por proceso; en HTTP es el sessionId de cada conexión.
 */
export function createReservaServer(clientId: string): McpServer {
  const server = new McpServer(
    { name: "reserva-mcp", version: "1.0.0" },
    {
      instructions:
        "Servidor MCP de reservas para un restaurante. Usa check_availability antes de " +
        "create_reservation para confirmar que hay hueco. Las horas van en ISO 8601 con zona horaria.",
    }
  );

  function guarded<Args, Result>(name: string, handler: (args: Args) => Promise<Result>) {
    const logged = withLogging(name, handler);
    return async (args: Args) => {
      checkRateLimit(clientId); // lanza RateLimitExceededError si excede el límite
      return logged(args);
    };
  }

  server.registerTool(
    "check_availability",
    {
      title: "Consultar disponibilidad",
      description:
        "Devuelve las mesas disponibles para una fecha/hora y número de comensales. " +
        "Llama SIEMPRE a esta herramienta antes de create_reservation.",
      inputSchema: {
        startsAt: z
          .string()
          .datetime({ message: "Usa formato ISO 8601 con zona horaria, ej. 2026-09-20T21:00:00+02:00" })
          .describe("Fecha y hora de inicio deseada, ISO 8601"),
        partySize: z.number().int().min(1).max(20).describe("Número de comensales"),
      },
    },
    async ({ startsAt, partySize }) => {
      try {
        const tables = await guarded("check_availability", () =>
          findAvailableTables(RESTAURANT_SLUG, startsAt, partySize)
        )({ startsAt, partySize });
        return ok({ available: tables.length > 0, tables });
      } catch (err) {
        return fail(describeError(err));
      }
    }
  );

  server.registerTool(
    "create_reservation",
    {
      title: "Crear reserva",
      description:
        "Reserva una mesa para el cliente. Falla si no hay disponibilidad -- en ese caso, " +
        "sugiere al usuario llamar a check_availability con otra franja.",
      inputSchema: {
        customerName: z.string().min(1).describe("Nombre del cliente"),
        customerPhone: z.string().min(6).describe("Teléfono de contacto"),
        partySize: z.number().int().min(1).max(20),
        startsAt: z.string().datetime().describe("Fecha y hora de inicio, ISO 8601"),
        notes: z.string().optional().describe("Notas: alergias, ocasión especial, etc."),
      },
    },
    async (args) => {
      try {
        const { startsAt, ...rest } = args;
        const reservation = await guarded("create_reservation", () =>
          createReservation({ restaurantSlug: RESTAURANT_SLUG, startsAtIso: startsAt, ...rest })
        )(args);
        return ok(reservation);
      } catch (err) {
        return fail(describeError(err));
      }
    }
  );

  server.registerTool(
    "cancel_reservation",
    {
      title: "Cancelar reserva",
      description: "Cancela una reserva existente por su ID.",
      inputSchema: {
        reservationId: z.string().uuid().describe("ID de la reserva a cancelar"),
      },
    },
    async ({ reservationId }) => {
      try {
        const result = await guarded("cancel_reservation", () =>
          cancelReservation(reservationId)
        )({ reservationId });
        return ok(result);
      } catch (err) {
        return fail(describeError(err));
      }
    }
  );

  server.registerTool(
    "get_reservation",
    {
      title: "Consultar reserva",
      description:
        "Busca una reserva por su ID, o todas las reservas activas de un teléfono si no se da ID.",
      inputSchema: {
        reservationId: z.string().uuid().optional(),
        customerPhone: z.string().optional(),
      },
    },
    async ({ reservationId, customerPhone }) => {
      try {
        const result = await guarded("get_reservation", () =>
          getReservation({ id: reservationId, phone: customerPhone })
        )({ reservationId, customerPhone });
        return ok(result);
      } catch (err) {
        return fail(describeError(err));
      }
    }
  );

  server.registerTool(
    "list_today_reservations",
    {
      title: "Listar reservas del día",
      description: "Uso administrativo: lista todas las reservas confirmadas de una fecha dada.",
      inputSchema: {
        date: z.string().datetime().describe("Cualquier instante ISO 8601 dentro del día a consultar"),
      },
    },
    async ({ date }) => {
      try {
        const result = await guarded("list_today_reservations", () =>
          listReservationsForDay(RESTAURANT_SLUG, date)
        )({ date });
        return ok(result);
      } catch (err) {
        return fail(describeError(err));
      }
    }
  );

  return server;
}

function describeError(err: unknown): string {
  if (err instanceof NoAvailabilityError) return `Sin disponibilidad: ${err.message}`;
  if (err instanceof ReservationNotFoundError) return err.message;
  if (err instanceof RateLimitExceededError) return err.message;
  return `Error interno: ${err instanceof Error ? err.message : String(err)}`;
}
