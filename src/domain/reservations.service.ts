import { pool } from "../db/pool.js";

export interface AvailableSlot {
  tableId: string;
  tableName: string;
  capacity: number;
}

export class NoAvailabilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoAvailabilityError";
  }
}

export class ReservationNotFoundError extends Error {
  constructor(id: string) {
    super(`Reserva ${id} no encontrada`);
    this.name = "ReservationNotFoundError";
  }
}

async function getRestaurant(slug: string) {
  const result = await pool.query(
    `SELECT id, turn_minutes FROM restaurants WHERE slug = $1`,
    [slug]
  );
  if (result.rows.length === 0) {
    throw new Error(`Restaurante '${slug}' no encontrado`);
  }
  return result.rows[0] as { id: string; turn_minutes: number };
}

/**
 * Busca mesas con capacidad suficiente y SIN solapamiento con ninguna
 * reserva confirmada en la franja [startsAt, startsAt + turno).
 *
 * Nota de diseño: esta consulta es una comprobación optimista (para
 * poder responder "sí hay hueco" antes de intentar reservar). La
 * garantía real contra condiciones de carrera la da el EXCLUDE
 * constraint de la tabla `reservations` -- si dos clientes piden la
 * misma mesa a la vez, esta consulta puede decir "libre" a ambos,
 * pero solo uno de los dos INSERT tendrá éxito; el otro recibe un
 * error de Postgres que se traduce a NoAvailabilityError más abajo.
 */
export async function findAvailableTables(
  restaurantSlug: string,
  startsAtIso: string,
  partySize: number
): Promise<AvailableSlot[]> {
  const restaurant = await getRestaurant(restaurantSlug);
  const startsAt = new Date(startsAtIso);
  const endsAt = new Date(startsAt.getTime() + restaurant.turn_minutes * 60000);

  const result = await pool.query(
    `SELECT t.id, t.name, t.capacity
     FROM restaurant_tables t
     WHERE t.restaurant_id = $1
       AND t.capacity >= $2
       AND NOT EXISTS (
         SELECT 1 FROM reservations r
         WHERE r.table_id = t.id
           AND r.status = 'confirmed'
           AND tstzrange(r.starts_at, r.ends_at) && tstzrange($3::timestamptz, $4::timestamptz)
       )
     ORDER BY t.capacity ASC`,
    [restaurant.id, partySize, startsAt.toISOString(), endsAt.toISOString()]
  );

  return result.rows.map((r) => ({
    tableId: r.id,
    tableName: r.name,
    capacity: r.capacity,
  }));
}

interface CreateReservationInput {
  restaurantSlug: string;
  customerName: string;
  customerPhone: string;
  partySize: number;
  startsAtIso: string;
  notes?: string;
}

export async function createReservation(input: CreateReservationInput) {
  const restaurant = await getRestaurant(input.restaurantSlug);
  const available = await findAvailableTables(
    input.restaurantSlug,
    input.startsAtIso,
    input.partySize
  );

  if (available.length === 0) {
    throw new NoAvailabilityError(
      `No hay mesas libres para ${input.partySize} personas a las ${input.startsAtIso}`
    );
  }

  const startsAt = new Date(input.startsAtIso);
  const endsAt = new Date(startsAt.getTime() + restaurant.turn_minutes * 60000);

  // Bajo concurrencia real, la mesa "mejor ajustada" (available[0]) puede
  // perder la carrera contra otro cliente que reservó una fracción de
  // segundo antes -- el EXCLUDE constraint rechaza ese INSERT concreto,
  // pero eso no significa que YA NO HAYA sitio: puede que otra mesa de
  // la lista siga libre. Intentamos las candidatas en orden hasta que
  // una tenga éxito o se agoten todas.
  let lastError: unknown;
  for (const candidate of available) {
    try {
      const result = await pool.query(
        `INSERT INTO reservations
           (restaurant_id, table_id, customer_name, customer_phone, party_size, starts_at, ends_at, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id, table_id, customer_name, customer_phone, party_size, status, starts_at, ends_at, notes`,
        [
          restaurant.id,
          candidate.tableId,
          input.customerName,
          input.customerPhone,
          input.partySize,
          startsAt.toISOString(),
          endsAt.toISOString(),
          input.notes ?? null,
        ]
      );
      return mapReservation(result.rows[0], candidate.tableName);
    } catch (err: any) {
      if (err.code === "23P01") {
        // Esta mesa concreta se la llevó otro cliente en este instante;
        // probamos con la siguiente candidata en vez de rendirnos.
        lastError = err;
        continue;
      }
      throw err;
    }
  }

  throw new NoAvailabilityError(
    "Todas las mesas candidatas se reservaron por otros clientes en el mismo instante. Prueba otra franja."
  );
}

export async function cancelReservation(reservationId: string) {
  const result = await pool.query(
    `UPDATE reservations SET status = 'cancelled'
     WHERE id = $1 AND status = 'confirmed'
     RETURNING id`,
    [reservationId]
  );
  if (result.rows.length === 0) {
    throw new ReservationNotFoundError(reservationId);
  }
  return { id: reservationId, status: "cancelled" as const };
}

export async function getReservation(query: { id?: string; phone?: string }) {
  if (query.id) {
    const result = await pool.query(
      `SELECT r.id, r.table_id, t.name AS table_name, r.customer_name, r.customer_phone,
              r.party_size, r.status, r.starts_at, r.ends_at, r.notes
       FROM reservations r JOIN restaurant_tables t ON t.id = r.table_id
       WHERE r.id = $1`,
      [query.id]
    );
    if (result.rows.length === 0) throw new ReservationNotFoundError(query.id);
    return mapReservation(result.rows[0], result.rows[0].table_name);
  }

  const result = await pool.query(
    `SELECT r.id, r.table_id, t.name AS table_name, r.customer_name, r.customer_phone,
            r.party_size, r.status, r.starts_at, r.ends_at, r.notes
     FROM reservations r JOIN restaurant_tables t ON t.id = r.table_id
     WHERE r.customer_phone = $1 AND r.status = 'confirmed'
     ORDER BY r.starts_at ASC`,
    [query.phone]
  );
  return result.rows.map((r) => mapReservation(r, r.table_name));
}

export async function listReservationsForDay(restaurantSlug: string, dateIso: string) {
  const restaurant = await getRestaurant(restaurantSlug);
  const dayStart = new Date(dateIso);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart);
  dayEnd.setDate(dayEnd.getDate() + 1);

  const result = await pool.query(
    `SELECT r.id, r.table_id, t.name AS table_name, r.customer_name, r.customer_phone,
            r.party_size, r.status, r.starts_at, r.ends_at, r.notes
     FROM reservations r JOIN restaurant_tables t ON t.id = r.table_id
     WHERE r.restaurant_id = $1 AND r.starts_at >= $2 AND r.starts_at < $3
       AND r.status = 'confirmed'
     ORDER BY r.starts_at ASC`,
    [restaurant.id, dayStart.toISOString(), dayEnd.toISOString()]
  );
  return result.rows.map((r) => mapReservation(r, r.table_name));
}

function mapReservation(row: any, tableName: string) {
  return {
    id: row.id,
    tableId: row.table_id,
    tableName,
    customerName: row.customer_name,
    customerPhone: row.customer_phone,
    partySize: row.party_size,
    status: row.status,
    startsAt: row.starts_at instanceof Date ? row.starts_at.toISOString() : row.starts_at,
    endsAt: row.ends_at instanceof Date ? row.ends_at.toISOString() : row.ends_at,
    notes: row.notes ?? undefined,
  };
}
