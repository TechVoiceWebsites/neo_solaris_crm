import { Router } from "express";
import { z } from "zod";
import { prisma } from "../config/db.js";
import { wrap, ok, parse, page, ApiError } from "../utils/http.js";
import { getLeadOr404, teamUserIds } from "../services/scope.js";
import { emitLead } from "../socket/index.js";

const r = Router();
const staffScope = async (u) => (u.role === "ADMIN" ? {} : u.role === "MANAGER" ? { staffId: { in: await teamUserIds(u) } } : { staffId: u.id });
const list = (extra) => wrap(async (req, res) => {
  const where = { ...(await staffScope(req.user)), ...extra(new Date()) };
  const { skip, take, p, size } = page(req.query);
  const [rows, total] = await Promise.all([prisma.followup.findMany({ where, skip, take, orderBy: { dueAt: "asc" }, include: { lead: { select: { id: true, customerName: true, company: true, phone: true } }, staff: { select: { id: true, name: true } } } }), prisma.followup.count({ where })]);
  ok(res, rows, { page: p, pageSize: size, total });
});
r.get("/today", list((n) => { const s = new Date(n); s.setHours(0, 0, 0, 0); return { status: "PENDING", dueAt: { gte: s, lt: new Date(s.getTime() + 86400000) } }; }));
r.get("/pending", list(() => ({ status: "PENDING" })));
r.get("/overdue", list((n) => ({ status: { in: ["PENDING", "OVERDUE"] }, dueAt: { lt: n } }))); // computed live, so it is correct even between job runs
r.get("/completed", list(() => ({ status: "COMPLETED" })));
r.post("/", wrap(async (req, res) => {
  const d = parse(z.object({ leadId: z.string().uuid(), dueAt: z.coerce.date(), type: z.enum(["CALL", "WHATSAPP", "EMAIL", "MEETING"]).default("CALL"), note: z.string().max(1000).optional() }), req.body);
  if (d.dueAt.getTime() < Date.now() - 60000) throw new ApiError(422, "Pick a follow-up time in the future", { dueAt: ["Must be in the future"] });
  const lead = await getLeadOr404(req.user, d.leadId);
  const f = await prisma.$transaction(async (tx) => {
    const created = await tx.followup.create({ data: { leadId: lead.id, staffId: req.user.id, dueAt: d.dueAt, type: d.type, note: d.note } });
    const next = await tx.followup.findFirst({ where: { leadId: lead.id, status: { in: ["PENDING", "OVERDUE"] } }, orderBy: { dueAt: "asc" } });
    await tx.lead.update({ where: { id: lead.id }, data: { nextFollowupAt: next.dueAt } });
    return created;
  });
  await emitLead("followup:created", lead, { followupId: f.id });
  ok(res, f, undefined, 201);
}));
r.put("/:id", wrap(async (req, res) => {
  const f = await prisma.followup.findFirst({ where: { id: req.params.id, ...(await staffScope(req.user)) } });
  if (!f) throw new ApiError(404, "Follow-up not found");
  const lead = await getLeadOr404(req.user, f.leadId);
  const d = parse(z.object({ status: z.enum(["COMPLETED", "CANCELLED"]), notes: z.string().max(2000).optional(), outcome: z.enum(["CONNECTED", "NOT_REACHABLE", "CALL_BACK_LATER", "INTERESTED", "NOT_INTERESTED", "WRONG_NUMBER"]).optional() }), req.body);
  const out = await prisma.$transaction(async (tx) => {
    const u = await tx.followup.update({ where: { id: f.id }, data: { status: d.status, completedAt: d.status === "COMPLETED" ? new Date() : null } });
    // Completing a follow-up writes to lead activity history; nothing earlier is overwritten.
    if (d.status === "COMPLETED") await tx.callActivity.create({ data: { leadId: f.leadId, staffId: req.user.id, calledAt: new Date(), type: f.type, outcome: d.outcome, notes: d.notes ?? f.note } });
    const next = await tx.followup.findFirst({ where: { leadId: f.leadId, status: { in: ["PENDING", "OVERDUE"] } }, orderBy: { dueAt: "asc" } });
    await tx.lead.update({ where: { id: f.leadId }, data: { nextFollowupAt: next?.dueAt ?? null } });
    return u;
  });
  await emitLead("followup:updated", lead, { followupId: out.id });
  ok(res, out);
}));
export default r;
