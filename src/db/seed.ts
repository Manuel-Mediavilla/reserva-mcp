import "dotenv/config";
import { pool } from "./pool.js";

async function seed() {
  const restaurant = await pool.query(
    `INSERT INTO restaurants (name, slug, turn_minutes)
     VALUES ('Restaurante Demo', 'demo', 90)
     ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`
  );
  const restaurantId = restaurant.rows[0].id;

  const tablesData = [
    { name: "Mesa 1", capacity: 2 },
    { name: "Mesa 2", capacity: 2 },
    { name: "Mesa 3", capacity: 4 },
    { name: "Mesa 4", capacity: 4 },
    { name: "Terraza 1", capacity: 6 },
  ];

  const tableIds: string[] = [];
  for (const t of tablesData) {
    const existing = await pool.query(
      `SELECT id FROM restaurant_tables WHERE restaurant_id = $1 AND name = $2`,
      [restaurantId, t.name]
    );
    if (existing.rows.length > 0) {
      tableIds.push(existing.rows[0].id);
      continue;
    }
    const inserted = await pool.query(
      `INSERT INTO restaurant_tables (restaurant_id, name, capacity)
       VALUES ($1, $2, $3) RETURNING id`,
      [restaurantId, t.name, t.capacity]
    );
    tableIds.push(inserted.rows[0].id);
  }

  // Una reserva ya existente mañana a las 21:00, para que el harness de
  // evaluación tenga un caso real de "esa franja ya no está libre".
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(21, 0, 0, 0);
  const ends = new Date(tomorrow.getTime() + 90 * 60000);

  await pool.query(
    `INSERT INTO reservations (restaurant_id, table_id, customer_name, customer_phone, party_size, starts_at, ends_at)
     VALUES ($1, $2, 'Laura Gómez', '+34600111222', 4, $3, $4)
     ON CONFLICT DO NOTHING`,
    [restaurantId, tableIds[2], tomorrow.toISOString(), ends.toISOString()]
  );

  console.log(`Seed completado. Restaurant ID: ${restaurantId}`);
  console.log(`Mesas: ${tableIds.length}`);
  await pool.end();
}

seed().catch((err) => {
  console.error("Error en seed:", err);
  process.exit(1);
});
