/**
 * Rate limiting muy simple: ventana fija en memoria por clientId.
 * Suficiente para el alcance de este proyecto (single-instance); en
 * producción con varias réplicas del servidor esto viviría en Redis,
 * no en memoria del proceso -- lo anoto en el README, no lo escondo.
 */
const WINDOW_MS = 60_000;
const MAX_CALLS_PER_WINDOW = 30;

const hits = new Map<string, number[]>();

export class RateLimitExceededError extends Error {
  constructor(clientId: string) {
    super(`Límite de ${MAX_CALLS_PER_WINDOW} llamadas/minuto excedido para ${clientId}`);
    this.name = "RateLimitExceededError";
  }
}

export function checkRateLimit(clientId: string): void {
  const now = Date.now();
  const windowStart = now - WINDOW_MS;
  const timestamps = (hits.get(clientId) ?? []).filter((t) => t > windowStart);

  if (timestamps.length >= MAX_CALLS_PER_WINDOW) {
    throw new RateLimitExceededError(clientId);
  }

  timestamps.push(now);
  hits.set(clientId, timestamps);
}
