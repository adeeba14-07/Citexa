import type { RequestHandler } from "express";
import { getUserId } from "../lib/auth";
import { logger } from "../lib/logger";

const requireAuth: RequestHandler = (req, res, next) => {
  let userId: string | null;
  try {
    userId = getUserId(req);
  } catch (error) {
    logger.warn({ error, path: req.path }, "Could not validate the account session");
    res.status(401).json({ error: "We could not verify your sign-in session. Please sign in again; if this continues, check the Clerk keys in your local .env file." });
    return;
  }
  if (!userId) {
    res.status(401).json({ error: "Sign in to continue." });
    return;
  }

  res.locals.userId = userId;
  next();
};

export default requireAuth;
