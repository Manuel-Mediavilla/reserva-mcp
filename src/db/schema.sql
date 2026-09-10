-- ============================================================
-- Esquema: Reservas de restaurante (dominio del servidor MCP)
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "btree_gist"; -- necesaria para el EXCLUDE de solapamiento

CREATE TABLE IF NOT EXISTS restaurants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  turn_minutes INT NOT NULL DEFAULT 90, -- duración estándar de un turno de mesa
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS restaurant_tables (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,       -- "Mesa 4", "Terraza 2"
  capacity INT NOT NULL
);

CREATE TABLE IF NOT EXISTS reservations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  table_id UUID NOT NULL REFERENCES restaurant_tables(id),
  customer_name TEXT NOT NULL,
  customer_phone TEXT NOT NULL,
  party_size INT NOT NULL,
  status TEXT NOT NULL DEFAULT 'confirmed', -- confirmed | cancelled | completed | no_show
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL, -- starts_at + turn_minutes, calculado en la app
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),

  -- El corazón del dominio: Postgres rechaza a nivel de base de datos
  -- que dos reservas activas se solapen en la misma mesa. Esto no es
  -- una validación "de aplicación" que se puede saltar con una carrera
  -- de peticiones concurrentes -- es una garantía de la propia DB.
  -- (WHERE status = 'confirmed': una reserva cancelada libera la mesa)
  CONSTRAINT no_overlap EXCLUDE USING gist (
    table_id WITH =,
    tstzrange(starts_at, ends_at) WITH &&
  ) WHERE (status = 'confirmed')
);

CREATE INDEX IF NOT EXISTS idx_reservations_restaurant_time
  ON reservations(restaurant_id, starts_at);

CREATE INDEX IF NOT EXISTS idx_reservations_phone
  ON reservations(customer_phone);

-- ============================================================
-- Log de llamadas a herramientas MCP -- la pieza de observabilidad
-- que sienta la base del panel de evaluación (siguiente proyecto).
-- ============================================================
CREATE TABLE IF NOT EXISTS tool_call_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tool_name TEXT NOT NULL,
  arguments JSONB NOT NULL,
  success BOOLEAN NOT NULL,
  error_message TEXT,
  latency_ms INT NOT NULL,
  client_id TEXT, -- identifica sesión/cliente MCP, usado para rate limiting
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tool_logs_name_time
  ON tool_call_logs(tool_name, created_at);
