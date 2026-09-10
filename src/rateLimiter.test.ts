import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { checkRateLimit, RateLimitExceededError } from "./rateLimiter.js";

describe("rateLimiter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("permite hasta 30 llamadas por minuto", () => {
    const clientId = `client-${Math.random()}`;
    for (let i = 0; i < 30; i++) {
      expect(() => checkRateLimit(clientId)).not.toThrow();
    }
  });

  it("rechaza la llamada número 31 dentro de la misma ventana", () => {
    const clientId = `client-${Math.random()}`;
    for (let i = 0; i < 30; i++) checkRateLimit(clientId);
    expect(() => checkRateLimit(clientId)).toThrow(RateLimitExceededError);
  });

  it("libera cupo pasada la ventana de 60s", () => {
    const clientId = `client-${Math.random()}`;
    for (let i = 0; i < 30; i++) checkRateLimit(clientId);
    vi.advanceTimersByTime(61_000);
    expect(() => checkRateLimit(clientId)).not.toThrow();
  });

  it("no comparte cupo entre clientes distintos", () => {
    const a = `client-a-${Math.random()}`;
    const b = `client-b-${Math.random()}`;
    for (let i = 0; i < 30; i++) checkRateLimit(a);
    expect(() => checkRateLimit(b)).not.toThrow();
  });
});
