import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";

export interface SecurityConfig {
  host: string;
  token?: string;
  corsOrigins: Set<string>;
}

export function loadSecurityConfig(env: NodeJS.ProcessEnv = process.env): SecurityConfig {
  const host = env.HOST || "127.0.0.1";
  const token = env.API_BEARER_TOKEN || undefined;
  const loopback = host === "127.0.0.1" || host === "::1" || host === "localhost";
  if (!loopback && !token && env.UNSAFE_ALLOW_UNAUTHENTICATED !== "true") {
    throw new Error("API_BEARER_TOKEN is required when HOST is non-loopback");
  }
  return {
    host,
    token,
    corsOrigins: new Set((env.CORS_ORIGINS || "").split(",").map((v) => v.trim()).filter(Boolean)),
  };
}

export function authenticate(config: SecurityConfig) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!config.token) return next();
    const value = req.get("authorization") || "";
    const supplied = value.startsWith("Bearer ") ? value.slice(7) : "";
    const expectedBuffer = Buffer.from(config.token);
    const suppliedBuffer = Buffer.from(supplied);
    const valid = suppliedBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(suppliedBuffer, expectedBuffer);
    if (!valid) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    next();
  };
}

interface Bucket { count: number; resetAt: number }
const buckets = new Map<string, Bucket>();

export function rateLimit(limit: number, windowMs = 60_000) {
  return (req: Request, res: Response, next: NextFunction) => {
    const auth = req.get("authorization") || "";
    const identity = auth ? crypto.createHash("sha256").update(auth).digest("hex") : req.ip;
    const key = `${req.baseUrl}:${identity}`;
    const now = Date.now();
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) bucket = { count: 0, resetAt: now + windowMs };
    bucket.count++;
    buckets.set(key, bucket);
    if (bucket.count > limit) {
      res.setHeader("Retry-After", String(Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))));
      res.status(429).json({ error: "rate_limited" });
      return;
    }
    next();
  };
}
