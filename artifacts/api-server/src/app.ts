import path from "node:path";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import { clerkMiddleware } from "@clerk/express";
import { publishableKeyFromHost } from "@clerk/shared/keys";
import pinoHttp from "pino-http";
import router from "./routes";
import { DEMO_MODE } from "./lib/auth";
import { logger } from "./lib/logger";
import {
  CLERK_PROXY_PATH,
  clerkProxyMiddleware,
  getClerkProxyHost,
} from "./middlewares/clerkProxyMiddleware";

const app: Express = express();

// Hosting behind a proxy (Render): trust X-Forwarded-* so req.protocol is "https".
// Only active when TRUST_PROXY is set, so local development is unchanged.
if (process.env.TRUST_PROXY) app.set("trust proxy", Number(process.env.TRUST_PROXY) || 1);

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
if (!DEMO_MODE) app.use(CLERK_PROXY_PATH, clerkProxyMiddleware());
app.use(cors({ credentials: true, origin: true }));
// Photo questions are resized in the browser before base64 transport; cap JSON bodies at 8 MB.
app.use(express.json({ limit: "8mb" }));
app.use(express.urlencoded({ extended: true }));

if (!DEMO_MODE) {
  app.use(
    clerkMiddleware((req) => ({
      publishableKey: publishableKeyFromHost(
        getClerkProxyHost(req) ?? "",
        process.env.CLERK_PUBLISHABLE_KEY,
      ),
    })),
  );
}

app.use("/api", router);

// Keep unhandled route/database failures actionable in local development.
// In production, log the cause without returning internals to the browser.
app.use((error: unknown, req: Request, res: Response, next: NextFunction) => {
  if (res.headersSent) return next(error);
  const err = error instanceof Error ? error : new Error(String(error));
  logger.error({ err, method: req.method, url: req.originalUrl }, "Unhandled API request error");
  const missingSchema = /relation ["'`]?.+["'`]? does not exist|table ["'`]?.+["'`]? does not exist/i.test(err.message);
  const status = Number((error as { status?: unknown; statusCode?: unknown })?.statusCode ?? (error as { status?: unknown })?.status);
  const statusCode = Number.isInteger(status) && status >= 400 && status < 600 ? status : 500;
  const message = missingSchema
    ? "The database schema is out of date. Stop the app, verify DATABASE_URL, and run pnpm run setup once."
    : process.env.NODE_ENV !== "production" && err.message
      ? err.message
      : "The request failed unexpectedly. Check the API server logs and database connection.";
  res.status(statusCode).json({ error: message });
});

// Production: serve the built web app from this same server (set SERVE_WEB_DIR).
// Unset locally, where Vite serves the web app on port 5173.
if (process.env.SERVE_WEB_DIR) {
  const webDir = path.resolve(process.env.SERVE_WEB_DIR);
  app.use(express.static(webDir));
  app.use((req, res, next) => {
    if (req.method !== "GET" || req.path.startsWith("/api")) return next();
    res.sendFile(path.join(webDir, "index.html"));
  });
}

export default app;
