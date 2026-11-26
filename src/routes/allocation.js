import { Router } from "express";
import { z } from "zod";
import { prisma } from "../config/db.js";
import { wrap, ok, parse, page, ApiError } from "../utils/http.js";
import { requireRole } from "../middleware/auth.js";
import { teamUserIds, leadScope } from "../services/scope.js";
import { assignLead, pickRoundRobin } from "../services/leadService.js";
import { emitLead, emitTo } from "../socket/index.js";

const r = Router();
r.use(requireRole("ADMIN", "MANAGER"));
const body = z.object({ leadIds: z.array(z.string().uuid()).min(1).max(100), assigneeId: z.string().uuid().optional(), method: z.enum(["MANUAL", "ROUND_ROBIN"]).default("MANUAL"), note: z.string().max(300).optional() })
  .refine((v) => v.method === "ROUND_ROBIN" || v.assigneeId, "Choose who to assign to");

r.post("/", wrap(async (req, res) => {
  const d = parse(body, req.body);
  const allowedAssignees = req.user.role === "ADMIN" ? null : await teamUserIds(req.user);
  const staff = await prisma.user.findMany({ where: { isActive: true, deletedAt: null, role: { in: ["SALES_STAFF", "MANAGER"] }, ...(allowedAssignees && { id: { in: allowedAssignees } }) }, select: { id: true, role: true } });
  const pool = staff.filter((s) => s.role === "SALES_STAFF").map((s) => s.id);
  if (d.assigneeId && !staff.some((s) => s.id === d.assigneeId)) throw new ApiError(403, "You cannot assign to this person");
  // Leads a manager may touch: in team scope, or still unassigned.
  const scope = req.user.role === "ADMIN" ? { deletedAt: null } : { deletedAt: null, OR: [{ currentOwnerId: null }, await leadScope(req.user)] };
  const leads = await prisma.lead.findMany({ where: { id: { in: d.leadIds }, ...scope } });
  if (leads.length !== d.leadIds.length) throw new ApiError(404, "One or more leads were not found");

  const done = [];
  for (const l of leads) {
    const to = d.method === "ROUND_ROBIN" ? await pickRoundRobin(prisma, pool) : d.assigneeId;
    if (l.currentOwnerId === to) continue; // no duplicate assignment event
    done.push(await assignLead(prisma, { leadId: l.id, assigneeId: to, byId: req.user.id, note: d.note }));
  }

  for (const l of done) { await emitLead("lead:assigned", l); emitTo(`user:${l.currentOwnerId}`, "notification", { type: "lead:assigned", leadId: l.id }); }
  ok(res, { assigned: done.length, skipped: leads.length - done.length });
}));

r.get("/", wrap(async (req, res) => {
  const lead = await leadScope(req.user);
  const { skip, take, p, size } = page(req.query);
  const where = { lead: req.user.role === "ADMIN" ? {} : lead };
  const [rows, total] = await Promise.all([prisma.leadAssignment.findMany({ where, skip, take, orderBy: { assignedAt: "desc" }, include: { lead: { select: { id: true, customerName: true, company: true } }, assignedTo: { select: { id: true, name: true } }, assignedBy: { select: { id: true, name: true } } } }), prisma.leadAssignment.count({ where })]);
  ok(res, rows, { page: p, pageSize: size, total });
}));

export default r;