import { getAuth } from "@clerk/express";
import type { Request } from "express";

/**
 * DEMO_MODE=true skips Clerk entirely and treats every request as one fixed
 * demo user. This is what makes the project run locally with only a Groq
 * key and a database URL.
 */
export const DEMO_MODE = process.env.DEMO_MODE === "true";
export const DEMO_USER_ID = "demo-user";

export function getUserId(req: Request): string | null {
  if (DEMO_MODE) return DEMO_USER_ID;
  return getAuth(req).userId ?? null;
}
