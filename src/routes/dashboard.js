import { Router } from "express";
import { prisma } from "../config/db.js";
import { wrap, ok, istDayStart } from "../utils/http.js";
import { leadScope, teamUserIds } from "../services/scope.js";

const r = Router();
const DAY = 86400000;

// ---------------------------------------------------------------------------------------------
// Lightweight in-memory caches (cut repeated Supabase round-trips from ~2.5s down to <150ms)
// ---------------------------------------------------------------------------------------------
const STATIC_TTL = 5 * 60_000; // LeadSource & PipelineStage rarely change
const DASH_TTL = 10_000;       // 10s snapshot cache per user + range (bypassed when ?fresh=1)

let cachedSources = null; // { rows, at }
let cachedStages = null;  // { rows, at }
const dashCache = new Map(); // key -> { payload, at }

async function getSources() {
  if (cachedSources && Date.now() - cachedSources.at < STATIC_TTL) return cachedSources.rows;
  const rows = await prisma.leadSource.findMany();
  cachedSources = { rows, at: Date.now() };
  return rows;
}

async function getStages() {
  if (cachedStages && Date.now() - cachedStages.at < STATIC_TTL) return cachedStages.rows;
  const rows = await prisma.pipelineStage.findMany({ orderBy: { position: "asc" } });
  cachedStages = { rows, at: Date.now() };
  return rows;
}

function range(q) {
  const t = istDayStart(), now = new Date();
  switch (q.range) {
    case "today": return { gte: t };
    case "yesterday": return { gte: new Date(t - DAY), lt: t };
    case "week": return { gte: new Date(t - ((new Date(t.getTime() + 330 * 60000).getUTCDay() + 6) % 7) * DAY) };
    case "month": {
      const i = new Date(now.getTime() + 330 * 60000);
      return { gte: new Date(Date.UTC(i.getUTCFullYear(), i.getUTCMonth(), 1) - 330 * 60000) };
    }
    case "custom": {
      const istStart = (value) => new Date(`${value}T00:00:00+05:30`);
      return {
        ...(q.from && { gte: istStart(q.from) }),
        ...(q.to && { lt: new Date(istStart(q.to).getTime() + DAY) }),
      };
    }
    default: return undefined;
  }
}

// Per-request memoized context so leadScope / teamUserIds only hit DB ONCE per request
function getCtx(req) {
  if (req._dashCtx) return req._dashCtx;
  const scopeP = leadScope(req.user);
  const teamP = req.user.role === "MANAGER" ? teamUserIds(req.user) : Promise.resolve(null);
  const fuP = (async () => {
    if (req.user.role === "ADMIN") return {};
    if (req.user.role === "MANAGER") return { staffId: { in: await teamP } };
    return { staffId: req.user.id };
  })();
  const filtersP = (async () => {
    const q = req.query;
    const scope = await scopeP;
    const createdAt = range(q);
    let owner;
    if (q.staffId) owner = [q.staffId];
    else if (q.managerId && req.user.role === "ADMIN") owner = await teamUserIds({ id: q.managerId });

    const where = { ...scope, ...(createdAt && { createdAt }), ...(q.sourceId && { sourceId: q.sourceId }) };
    if (owner) {
      where.currentOwnerId = scope.currentOwnerId
        ? { in: owner.filter((id) => (scope.currentOwnerId.in ?? [scope.currentOwnerId]).includes(id)) }
        : { in: owner };
    }
    return where;
  })();

  req._dashCtx = { scopeP, fuP, filtersP };
  return req._dashCtx;
}

// ---------------------------------------------------------------------------------------------
// Section builders (reused by both the combined GET /api/dashboard and individual endpoints)
// ---------------------------------------------------------------------------------------------
async function buildOverview(req) {
  const { scopeP, fuP, filtersP } = getCtx(req);
  const [where, scope, fu] = await Promise.all([filtersP, scopeP, fuP]);
  const t = istDayStart(), now = new Date();
  const leadIdScope = { lead: { is: scope } };

  // Split 10 counts into 2 calm batches of 5 so Supabase pooler never saturates
  const [total, today, unassigned, won, lost, valid, invalid, followupLeadRows] = await Promise.all([
    prisma.lead.count({ where }),
    prisma.lead.count({ where: { ...where, createdAt: { gte: t } } }),
    prisma.lead.count({ where: { ...where, currentOwnerId: null } }),
    prisma.lead.count({ where: { ...where, status: "WON" } }),
    prisma.lead.count({ where: { ...where, status: "LOST" } }),
    prisma.lead.count({ where: { ...where, validityStatus: "VALID" } }),
    prisma.lead.count({ where: { ...where, validityStatus: "INVALID" } }),
    prisma.followup.findMany({
      where: {
        status: { in: ["PENDING", "OVERDUE"] },
        lead: { is: where },
      },
      distinct: ["leadId"],
      select: { leadId: true },
    }),
  ]);
  const followup = followupLeadRows.length;

  const [dueToday, overdue, pending, quotations, orders] = await Promise.all([
    prisma.followup.count({ where: { ...fu, status: "PENDING", dueAt: { gte: t, lt: new Date(t.getTime() + DAY) } } }),
    prisma.followup.count({ where: { ...fu, status: { in: ["PENDING", "OVERDUE"] }, dueAt: { lt: now } } }),
    prisma.followup.count({ where: { ...fu, status: "PENDING" } }),
    prisma.quotation.count({ where: { deletedAt: null, ...leadIdScope } }),
    prisma.orderInstallation.aggregate({ where: { confirmedAt: { not: null }, ...leadIdScope }, _count: true, _sum: { orderValue: true } }),
  ]);

  return {
    pendingFollowups: pending,
    quotations,
    confirmedOrders: orders._count,
    totalSalesValue: Number(orders._sum.orderValue ?? 0),
    total,
    today,
    unassigned,
    assigned: total - unassigned,
    followupsDueToday: dueToday,
    overdueFollowups: overdue,
    won,
    lost,
    valid,
    invalid,
    followup,
    converted: won,
    active: total - won - lost,
    conversionRate: total ? Math.round((won / total) * 1000) / 10 : 0,
  };
}

async function buildLeadsBySource(req) {
  const where = await getCtx(req).filtersP;
  const [g, src] = await Promise.all([
    prisma.lead.groupBy({ by: ["sourceId"], where, _count: true }),
    getSources(),
  ]);
  const srcMap = new Map(src.map((s) => [s.id, s.name]));
  return g.map((x) => ({ source: srcMap.get(x.sourceId), count: x._count }));
}

async function buildPipeline(req) {
  const where = await getCtx(req).filtersP;
  const [g, stages] = await Promise.all([
    prisma.lead.groupBy({ by: ["stageId"], where, _count: true }),
    getStages(),
  ]);
  const countMap = new Map(g.map((x) => [x.stageId, x._count]));
  return stages.map((s) => ({
    id: s.id,
    name: s.name,
    stage: s.name,
    position: s.position,
    isLost: s.isLost ?? false,
    count: countMap.get(s.id) ?? 0,
  }));
}

async function buildTrend(req) {
  const days = Math.min(90, Number(req.query.days) || 7);
  const start = new Date(istDayStart().getTime() - (days - 1) * DAY);
  const scope = await getCtx(req).scopeP;

  const [created, won] = await Promise.all([
    prisma.lead.findMany({ where: { ...scope, createdAt: { gte: start } }, select: { createdAt: true } }),
    prisma.lead.findMany({ where: { ...scope, status: "WON", updatedAt: { gte: start } }, select: { updatedAt: true } }),
  ]);

  const key = (d) => new Date(d.getTime() + 330 * 60000).toISOString().slice(0, 10);
  const out = Array.from({ length: days }, (_, i) => ({ date: key(new Date(start.getTime() + i * DAY)), leads: 0, won: 0 }));
  const idx = new Map(out.map((o) => [o.date, o]));
  created.forEach((l) => { const o = idx.get(key(l.createdAt)); if (o) o.leads++; });
  won.forEach((l) => { const o = idx.get(key(l.updatedAt)); if (o) o.won++; });
  return out;
}

async function buildFollowups(req) {
  const fu = await getCtx(req).fuP;
  const now = new Date();
  const [completed, pending, overdue] = await Promise.all([
    prisma.followup.count({ where: { ...fu, status: "COMPLETED" } }),
    prisma.followup.count({ where: { ...fu, status: "PENDING", dueAt: { gte: now } } }),
    prisma.followup.count({ where: { ...fu, status: { in: ["PENDING", "OVERDUE"] }, dueAt: { lt: now } } }),
  ]);
  return [
    { name: "Completed", count: completed },
    { name: "Pending", count: pending },
    { name: "Overdue", count: overdue },
  ];
}

async function buildStaffPerformance(req) {
  if (req.user.role === "SALES_STAFF" || req.user.role === "STAFF") return [];
  const { filtersP, fuP } = getCtx(req);
  const [where, fu] = await Promise.all([filtersP, fuP]);

  const [all, won, fus] = await Promise.all([
    prisma.lead.groupBy({
      by: ["currentOwnerId"],
      where: { ...where, currentOwnerId: { not: null } },
      _count: true,
      _sum: { estimatedValue: true },
    }),
    prisma.lead.groupBy({
      by: ["currentOwnerId"],
      where: { ...where, status: "WON" },
      _count: true,
      _sum: { estimatedValue: true },
    }),
    prisma.followup.groupBy({ by: ["staffId", "status"], where: fu, _count: true }),
  ]);

  if (!all.length) return [];
  const users = await prisma.user.findMany({
    where: { id: { in: all.map((a) => a.currentOwnerId) } },
    select: { id: true, name: true },
  });
  const userMap = new Map(users.map((u) => [u.id, u.name]));
  const wonMap = new Map(won.map((w) => [w.currentOwnerId, w]));

  const completedMap = new Map();
  const pendingMap = new Map();
  const overdueMap = new Map();
  for (const f of fus) {
    if (f.status === "COMPLETED") completedMap.set(f.staffId, f._count);
    if (f.status === "PENDING") pendingMap.set(f.staffId, f._count);
    if (f.status === "OVERDUE") overdueMap.set(f.staffId, f._count);
  }

  return all.map((a) => {
    const w = wonMap.get(a.currentOwnerId);
    const wonCount = w?._count ?? 0;
    return {
      staffId: a.currentOwnerId,
      name: userMap.get(a.currentOwnerId),
      assigned: a._count,
      won: wonCount,
      salesValue: Number(w?._sum.estimatedValue ?? 0),
      completedFollowups: completedMap.get(a.currentOwnerId) ?? 0,
      pendingFollowups: pendingMap.get(a.currentOwnerId) ?? 0,
      overdueFollowups: overdueMap.get(a.currentOwnerId) ?? 0,
      conversionRate: a._count ? Math.round((wonCount / a._count) * 1000) / 10 : 0,
    };
  });
}

// ---------------------------------------------------------------------------------------------
// Combined endpoint: returns ALL dashboard sections in ONE HTTP call (eliminates 6x waterfall)
// ---------------------------------------------------------------------------------------------
r.get("/", wrap(async (req, res) => {
  const cacheKey = `${req.user.id}|${req.user.role}|${req.query.range ?? ""}|${req.query.from ?? ""}|${req.query.to ?? ""}|${req.query.staffId ?? ""}|${req.query.managerId ?? ""}|${req.query.sourceId ?? ""}`;
  if (req.query.fresh !== "1") {
    const hit = dashCache.get(cacheKey);
    if (hit && Date.now() - hit.at < DASH_TTL) return ok(res, hit.payload);
  }

  // Run in two calm batches so the Supabase connection pool never saturates (prevents P1001)
  const [overview, leadsBySource, pipeline] = await Promise.all([
    buildOverview(req),
    buildLeadsBySource(req),
    buildPipeline(req),
  ]);
  const [followups, trend, staffPerformance] = await Promise.all([
    buildFollowups(req),
    buildTrend(req),
    buildStaffPerformance(req),
  ]);

  const payload = {
    overview,
    "leads-by-source": leadsBySource,
    pipeline,
    byStage: pipeline, // keeps Pipeline.jsx compatibility
    followups,
    trend,
    "staff-performance": staffPerformance,
  };
  dashCache.set(cacheKey, { payload, at: Date.now() });
  ok(res, payload);
}));

r.get("/overview", wrap(async (req, res) => ok(res, await buildOverview(req))));
r.get("/leads-by-source", wrap(async (req, res) => ok(res, await buildLeadsBySource(req))));
r.get("/pipeline", wrap(async (req, res) => ok(res, await buildPipeline(req))));
r.get("/status", wrap(async (req, res) => {
  const g = await prisma.lead.groupBy({ by: ["status"], where: await getCtx(req).filtersP, _count: true });
  ok(res, g.map((x) => ({ status: x.status, count: x._count })));
}));
r.get("/trend", wrap(async (req, res) => ok(res, await buildTrend(req))));
r.get("/monthly", wrap(async (req, res) => {
  const rows = await prisma.lead.findMany({
    where: { ...(await getCtx(req).scopeP), createdAt: { gte: new Date(Date.now() - 365 * DAY) } },
    select: { createdAt: true },
  });
  const m = {};
  for (const { createdAt } of rows) {
    const k = new Date(createdAt.getTime() + 330 * 60000).toISOString().slice(0, 7);
    m[k] = (m[k] || 0) + 1;
  }
  ok(res, Object.entries(m).sort().map(([month, count]) => ({ month, count })));
}));
r.get("/followups", wrap(async (req, res) => ok(res, await buildFollowups(req))));
r.get("/staff-performance", wrap(async (req, res) => ok(res, await buildStaffPerformance(req))));

export default r;