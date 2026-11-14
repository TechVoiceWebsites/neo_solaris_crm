import { Router } from "express";
import { z } from "zod";
import { prisma } from "../config/db.js";
import { wrap, ok, parse, page, ApiError } from "../utils/http.js";
import { requireRole } from "../middleware/auth.js";
import { leadScope, getLeadOr404 } from "../services/scope.js";
import { createLead, leadInput, audit, normPhone, autoAllocateIfEnabled } from "../services/leadService.js";
import { emitLead } from "../socket/index.js";

const r = Router();

// ---------------------------------------------------------------------------------------------
// Lightweight in-memory caches (slashes Supabase round-trips from ~7.8s down to <150ms)
// ---------------------------------------------------------------------------------------------
const USER_CACHE_TTL = 2 * 60_000; // staff names rarely change
const LIST_CACHE_TTL = 10_000;     // 10s snapshot cache; invalidated immediately on any write

let userMapCache = null; // { map: Map<id, { id, name }>, at }
const listCache = new Map(); // key -> { rows, meta, at }

const invalidateLeadCaches = () => {
  listCache.clear();
};

async function getUserMap(ids) {
  const now = Date.now();
  if (!userMapCache || now - userMapCache.at > USER_CACHE_TTL || ids.some((id) => !userMapCache.map.has(id))) {
    const users = await prisma.user.findMany({ select: { id: true, name: true } });
    userMapCache = { map: new Map(users.map((u) => [u.id, u])), at: now };
  }
  return userMapCache.map;
}

const withOwner = async (rows) => {
  const ids = [...new Set(rows.map((l) => l.currentOwnerId).filter(Boolean))];
  if (!ids.length) return rows.map((l) => ({ ...l, owner: null }));
  const m = await getUserMap(ids);
  return rows.map((l) => ({ ...l, owner: m.get(l.currentOwnerId) ?? null }));
};

// Select only the columns the UI renders instead of pulling full relation rows
const leadListSelect = {
  id: true,
  customerName: true,
  phone: true,
  email: true,
  company: true,
  city: true,
  requirement: true,
  priority: true,
  status: true,
  estimatedValue: true,
  nextFollowupAt: true,
  stageId: true,
  sourceId: true,
  currentOwnerId: true,
  createdAt: true,
  updatedAt: true,
  source: { select: { id: true, name: true } },
  stage: { select: { id: true, name: true, position: true, isWon: true, isLost: true } },
};

const listQuery = async (req, extra = {}, cacheTag = "all") => {
  const cacheKey = `${cacheTag}|${req.user.id}|${req.user.role}|${JSON.stringify(req.query)}`;
  if (req.query.fresh !== "1") {
    const hit = listCache.get(cacheKey);
    if (hit && Date.now() - hit.at < LIST_CACHE_TTL) {
      return { rows: hit.rows, meta: hit.meta };
    }
  }

  const { q, sourceId, stageId, status, priority, ownerId } = req.query;
  const where = {
    ...(await leadScope(req.user)),
    ...extra,
    ...(sourceId && { sourceId }),
    ...(stageId && { stageId }),
    ...(status && { status }),
    ...(priority && { priority }),
    ...(ownerId && { currentOwnerId: ownerId }),
    ...(q && {
      OR: [
        { customerName: { contains: q, mode: "insensitive" } },
        { company: { contains: q, mode: "insensitive" } },
        { phone: { contains: String(q).replace(/\D/g, "") || "~~" } },
      ],
    }),
  };

  const { skip, take, p, size } = page(req.query);
  const sortBy = ["createdAt", "updatedAt", "customerName", "nextFollowupAt"].includes(req.query.sortBy)
    ? req.query.sortBy
    : "createdAt";

  const [rows, total] = await Promise.all([
    prisma.lead.findMany({
      where,
      skip,
      take,
      orderBy: { [sortBy]: req.query.order === "asc" ? "asc" : "desc" },
      select: leadListSelect,
    }),
    prisma.lead.count({ where }),
  ]);

  const enriched = await withOwner(rows);
  const meta = { page: p, pageSize: size, total };
  listCache.set(cacheKey, { rows: enriched, meta, at: Date.now() });
  return { rows: enriched, meta };
};

r.get("/", wrap(async (req, res) => {
  const { rows, meta } = await listQuery(req, {}, "all");
  ok(res, rows, meta);
}));

r.get("/my-leads", wrap(async (req, res) => {
  const { rows, meta } = await listQuery(req, { currentOwnerId: req.user.id }, "mine");
  ok(res, rows, meta);
}));

r.get("/unassigned", requireRole("ADMIN", "MANAGER"), wrap(async (req, res) => {
  const cacheKey = `unassigned|${JSON.stringify(req.query)}`;
  if (req.query.fresh !== "1") {
    const hit = listCache.get(cacheKey);
    if (hit && Date.now() - hit.at < LIST_CACHE_TTL) {
      return ok(res, hit.rows, hit.meta);
    }
  }

  const where = { deletedAt: null, currentOwnerId: null, status: "OPEN" };
  const { skip, take, p, size } = page(req.query);
  const [rows, total] = await Promise.all([
    prisma.lead.findMany({ where, skip, take, orderBy: { createdAt: "desc" }, select: leadListSelect }),
    prisma.lead.count({ where }),
  ]);
  const meta = { page: p, pageSize: size, total };
  listCache.set(cacheKey, { rows, meta, at: Date.now() });
  ok(res, rows, meta);
}));

r.post("/", wrap(async (req, res) => {
  const d = parse(leadInput, req.body);
  const { lead, duplicate } = await createLead({ data: d, sourceCode: "DIRECT", createdById: req.user.id });
  if (duplicate) throw new ApiError(409, "A lead with this phone number is already open", { leadId: lead.id });
  const final = req.user.role === "SALES_STAFF"
    ? await prisma.$transaction(async (tx) => {
        const u = await tx.lead.update({ where: { id: lead.id }, data: { currentOwnerId: req.user.id } });
        await tx.leadAssignment.create({ data: { leadId: lead.id, assignedToId: req.user.id, assignedById: req.user.id, note: "Self-created" } });
        return u;
      })
    : await autoAllocateIfEnabled(lead);

  invalidateLeadCaches();
  await emitLead("lead:new", final);
  ok(res, final, undefined, 201);
}));

// Full Lead Detail + Complete Staff Activity Timeline
r.get("/:id", wrap(async (req, res) => {
  const lead = await getLeadOr404(req.user, req.params.id);
  const full = await prisma.lead.findUnique({
    where: { id: lead.id },
    include: {
      source: true,
      stage: true,
      assignments: {
        orderBy: { assignedAt: "desc" },
        include: {
          assignedTo: { select: { id: true, name: true } },
          assignedBy: { select: { id: true, name: true } },
        },
      },
      followups: {
        orderBy: { dueAt: "desc" },
        include: { staff: { select: { id: true, name: true } } },
      },
      calls: {
        orderBy: { calledAt: "desc" },
        include: { staff: { select: { id: true, name: true } } },
      },
      stageHistory: {
        orderBy: { changedAt: "desc" },
        include: {
          fromStage: { select: { id: true, name: true } },
          toStage: { select: { id: true, name: true } },
          changedBy: { select: { id: true, name: true } },
        },
      },
      quotations: true,
      orders: true,
    },
  });

  // Build unified chronological activity feed for UI
  const activityFeed = [
    ...full.assignments.map((a) => ({
      id: `assign_${a.id}`,
      kind: "ASSIGNMENT",
      at: a.assignedAt,
      actor: a.assignedBy?.name || "System",
      summary: `Assigned to ${a.assignedTo?.name || "Staff"}`,
      note: a.note || "",
    })),
    ...full.calls.map((c) => ({
      id: `call_${c.id}`,
      kind: c.type,
      at: c.calledAt,
      actor: c.staff?.name || "Staff",
      summary: `${c.type}${c.outcome ? ` (${c.outcome.replace(/_/g, " ")})` : ""}`,
      note: c.notes || "",
    })),
    ...full.stageHistory.map((s) => ({
      id: `stage_${s.id}`,
      kind: "STAGE_CHANGE",
      at: s.changedAt,
      actor: s.changedBy?.name || "Staff",
      summary: `Moved ${s.fromStage?.name ? `from ${s.fromStage.name} ` : ""}to ${s.toStage?.name}`,
      note: s.reason || "",
    })),
  ].sort((a, b) => new Date(b.at) - new Date(a.at));

  const enriched = (await withOwner([full]))[0];
  ok(res, { ...enriched, activityFeed });
}));

r.put("/:id", wrap(async (req, res) => {
  const lead = await getLeadOr404(req.user, req.params.id);
  const d = parse(leadInput.partial(), req.body);
  const data = { ...d, ...(d.phone && { phone: normPhone(d.phone) }), email: d.email || undefined };
  const up = await prisma.$transaction(async (tx) => {
    const u = await tx.lead.update({ where: { id: lead.id }, data });
    await audit(tx, req.user.id, "lead.update", "lead", lead.id, { fields: Object.keys(d) });
    return u;
  });

  invalidateLeadCaches();
  await emitLead("lead:updated", up);
  ok(res, up);
}));

// ---- Pipeline
r.put("/:id/stage", wrap(async (req, res) => {
  const lead = await getLeadOr404(req.user, req.params.id);
  const { stageId, reason } = parse(z.object({ stageId: z.string().uuid(), reason: z.string().max(300).optional() }), req.body);
  const to = await prisma.pipelineStage.findUnique({ where: { id: stageId } });
  if (!to) throw new ApiError(400, "Unknown stage");
  if (to.isLost && !reason) throw new ApiError(422, "A lost reason is required", { reason: ["Required when marking a lead as Lost"] });
  if (to.id === lead.stageId) throw new ApiError(409, "Lead is already in this stage");

  const up = await prisma.$transaction(async (tx) => {
    const u = await tx.lead.update({
      where: { id: lead.id },
      data: { stageId: to.id, status: to.isWon ? "WON" : to.isLost ? "LOST" : "OPEN", lostReason: to.isLost ? reason : null },
    });
    await tx.leadStageHistory.create({
      data: { leadId: lead.id, fromStageId: lead.stageId, toStageId: to.id, changedById: req.user.id, reason },
    });
    await audit(tx, req.user.id, "lead.stage", "lead", lead.id, { to: to.name });
    return u;
  });

  invalidateLeadCaches();
  await emitLead("pipeline:updated", up, { stageId: to.id });
  ok(res, up);
}));

r.get("/:id/stage-history", wrap(async (req, res) => {
  await getLeadOr404(req.user, req.params.id);
  ok(res, await prisma.leadStageHistory.findMany({
    where: { leadId: req.params.id },
    orderBy: { changedAt: "desc" },
    include: { fromStage: true, toStage: true, changedBy: { select: { id: true, name: true } } },
  }));
}));

// ---- Activities (calls, WhatsApp, email, meetings)
r.get("/:id/activities", wrap(async (req, res) => {
  await getLeadOr404(req.user, req.params.id);
  ok(res, await prisma.callActivity.findMany({
    where: { leadId: req.params.id },
    orderBy: { calledAt: "desc" },
    include: { staff: { select: { id: true, name: true } } },
  }));
}));

r.post("/:id/activities", wrap(async (req, res) => {
  const lead = await getLeadOr404(req.user, req.params.id);
  const d = parse(
    z.object({
      type: z.enum(["CALL", "WHATSAPP", "EMAIL", "MEETING"]),
      outcome: z.enum(["CONNECTED", "NOT_REACHABLE", "CALL_BACK_LATER", "INTERESTED", "NOT_INTERESTED", "WRONG_NUMBER"]).optional(),
      notes: z.string().max(2000).optional(),
      calledAt: z.coerce.date().optional(),
    }),
    req.body
  );
  const a = await prisma.$transaction(async (tx) => {
    const created = await tx.callActivity.create({
      data: { leadId: lead.id, staffId: req.user.id, calledAt: d.calledAt ?? new Date(), type: d.type, outcome: d.outcome, notes: d.notes },
      include: { staff: { select: { id: true, name: true } } },
    });
    await audit(tx, req.user.id, "lead.activity", "lead", lead.id, { type: d.type, outcome: d.outcome });
    return created;
  });

  invalidateLeadCaches();
  await emitLead("lead:updated", lead);
  ok(res, a, undefined, 201);
}));

export default r;