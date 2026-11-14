import { Router } from "express";
import { prisma } from "../config/db.js";
import { wrap, ok, ApiError, page } from "../utils/http.js";
import { authenticate, requireRole } from "../middleware/auth.js";
import { adapters } from "../integrations/adapters.js";
import { createLead, leadInput, autoAllocateIfEnabled } from "../services/leadService.js";
import { emitLead } from "../socket/index.js";

const r = Router();

// 1. Meta (Facebook / Instagram) Webhook Verification (GET /api/integrations/META/leads)
r.get("/:code/leads", (req, res) => {
  const code = req.params.code.toUpperCase();
  if (code !== "META") return res.sendStatus(404);

  const verifyToken = process.env.META_VERIFY_TOKEN || "neosolaris_meta_verify_2026";
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === verifyToken) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// 2. Public Webhook for All Sources (POST /api/integrations/:code/leads)
// Supports single payload (Website, PurePower, Meta) & batch array (IndiaMART RESPONSE[])
r.post("/:code/leads", wrap(async (req, res) => {
  const code = req.params.code.toUpperCase();
  const ad = adapters[code];
  if (!ad) throw new ApiError(404, "Unknown integration");

  const source = await prisma.leadSource.findUnique({ where: { code } });
  if (!source) throw new ApiError(404, "Lead source not seeded in database");
  if (!ad.configured()) throw new ApiError(503, "This integration is pending setup");

  const log = (status, extra = {}) =>
    prisma.integrationLog.create({
      data: { sourceId: source.id, status, payload: req.body ?? {}, ...extra },
    });

  if (!ad.verify(req)) {
    await log("REJECTED", { error: "Invalid signature or API key" });
    throw new ApiError(401, "Invalid signature");
  }

  // Handle batch payloads (e.g. IndiaMART sends RESPONSE array) or single payload
  const items = Array.isArray(req.body?.RESPONSE) ? req.body.RESPONSE : [req.body];
  let processed = 0;
  let duplicates = 0;

  for (const item of items) {
    const n = ad.normalize(item);
    const v = leadInput.safeParse(n.data);

    if (!v.success) {
      await log("FAILED", {
        externalId: n.externalId,
        error: JSON.stringify(v.error.flatten().fieldErrors),
      });
      if (items.length === 1) throw new ApiError(422, "Invalid lead data");
      continue;
    }

    const { lead, duplicate } = await createLead({
      data: v.data,
      sourceCode: code,
      externalId: n.externalId,
    });

    await log(duplicate ? "DUPLICATE" : "PROCESSED", { externalId: n.externalId });

    if (duplicate) {
      duplicates++;
    } else {
      processed++;
      await emitLead("lead:new", await autoAllocateIfEnabled(lead));
    }
  }

  ok(res, { received: true, processed, duplicate: duplicates > 0 && processed === 0, duplicates });
}));

// 3. Bulk CSV / Manual Import (POST /api/integrations/import/bulk)
r.post("/import/bulk", authenticate, requireRole("ADMIN"), wrap(async (req, res) => {
  const { sourceCode = "DIRECT", rows = [] } = req.body;
  const code = String(sourceCode).toUpperCase();

  if (!Array.isArray(rows) || rows.length === 0) {
    throw new ApiError(400, "No rows provided for import");
  }

  const source = await prisma.leadSource.findUnique({ where: { code } });
  if (!source) throw new ApiError(404, "Invalid source code");

  let created = 0;
  let duplicateCount = 0;
  let failed = 0;

  for (const row of rows) {
    const v = leadInput.safeParse({
      customerName: row.customerName || row.name,
      phone: row.phone ? String(row.phone).replace(/\s+/g, "").trim() : "",
      email: row.email || "",
      company: row.company || "",
      city: row.city || "",
      requirement: row.requirement || "CSV Imported Enquiry",
      description: row.description || "",
      estimatedValue: Number(row.estimatedValue || row.value || 0),
    });

    if (!v.success) {
      failed++;
      continue;
    }

    const { lead, duplicate } = await createLead({
      data: v.data,
      sourceCode: code,
      externalId: row.externalId || `csv_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    });

    if (duplicate) {
      duplicateCount++;
    } else {
      created++;
      await emitLead("lead:new", await autoAllocateIfEnabled(lead));
    }
  }

  ok(res, { created, duplicates: duplicateCount, failed });
}));

// 4. Integration Status Check (Admin)
r.get("/status", authenticate, requireRole("ADMIN"), wrap(async (_req, res) => {
  const sources = await prisma.leadSource.findMany({ orderBy: { name: "asc" } });
  ok(
    res,
    sources.map((s) => {
      const a = adapters[s.code];
      return {
        code: s.code,
        name: s.name,
        state:
          s.code === "DIRECT"
            ? "READY"
            : a?.configured()
            ? "CONFIGURED_UNTESTED"
            : "PENDING_SETUP",
        needs: a?.needs ?? null,
      };
    })
  );
}));

// 5. Integration Logs (Admin)
r.get("/logs", authenticate, requireRole("ADMIN"), wrap(async (req, res) => {
  const { skip, take, p, size } = page(req.query);
  const where = req.query.status ? { status: req.query.status } : {};
  const [rows, total] = await Promise.all([
    prisma.integrationLog.findMany({
      where,
      skip,
      take,
      orderBy: { createdAt: "desc" },
      include: { source: true },
    }),
    prisma.integrationLog.count({ where }),
  ]);
  ok(res, rows, { page: p, pageSize: size, total });
}));

export default r;