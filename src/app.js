import express from "express";
import helmet from "helmet";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { env } from "./config/env.js";
import { authenticate } from "./middleware/auth.js";
import { notFound, errorHandler } from "./middleware/error.js";
import { prisma } from "./config/db.js";
import { wrap, ok } from "./utils/http.js";
import auth from "./routes/auth.js";
import users from "./routes/users.js";
import leads from "./routes/leads.js";
import allocation from "./routes/allocation.js";
import followups from "./routes/followups.js";
import dashboard from "./routes/dashboard.js";
import integrations from "./routes/integrations.js";

export const app = express();
app.set("trust proxy", 1);
app.use(helmet());

const allowedOrigins = [
  "http://localhost:5173",
  "http://localhost:5174",
  "https://neo-solaris-crm.netlify.app",
  ...(env.frontendUrl ? env.frontendUrl.split(",") : []),
]
  .map((url) => url.trim().replace(/\/$/, ""))
  .filter(Boolean);

app.use(
  cors({
    origin: allowedOrigins,
    credentials: true,
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "x-signature",
      "x-api-key",
      "x-webhook-secret", // Added for IndiaMART Email-to-Webhook integration
    ],
  })
);

app.use(rateLimit({ windowMs: 60000, limit: 300 }));
app.use(
  express.json({
    limit: "2mb", // Increased from 200kb to support bulk CSV imports
    verify: (req, _res, buf) => {
      req.rawBody = buf; // rawBody for webhook HMAC signatures
    },
  })
);

const api = express.Router();
api.get(
  "/health",
  wrap(async (_req, res) => {
    await prisma.$queryRaw`SELECT 1`;
    ok(res, { status: "ok" });
  })
);
api.use("/auth", auth);
api.use("/integrations", integrations); // Public webhooks (signed) + admin routes (authenticated inside)
api.use(authenticate);
api.use("/users", users);
api.use("/leads", leads);
api.use("/allocation", allocation);
api.use("/allocations", allocation);
api.use("/followups", followups);
api.get(
  "/pipeline/stages",
  wrap(async (_req, res) =>
    ok(res, await prisma.pipelineStage.findMany({ orderBy: { position: "asc" } }))
  )
);
api.use("/dashboard", dashboard);

app.use("/api/v1", api);
app.use(notFound);
app.use(errorHandler);