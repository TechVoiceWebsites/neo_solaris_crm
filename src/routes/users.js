import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "../config/db.js";
import { wrap, ok, parse, ApiError } from "../utils/http.js";
import { requireRole } from "../middleware/auth.js";
import { audit } from "../services/leadService.js";

const r = Router();
const select = { id: true, name: true, email: true, role: true, isActive: true, profile: { select: { phone: true, teamName: true, managerId: true } } };
r.get("/", requireRole("ADMIN", "MANAGER"), wrap(async (req, res) => {
  const where = { deletedAt: null, ...(req.user.role === "MANAGER" && { OR: [{ id: req.user.id }, { profile: { manager: { userId: req.user.id } } }] }) };
  ok(res, await prisma.user.findMany({ where, select, orderBy: { name: "asc" } }));
}));
const body = z.object({ name: z.string().min(2), email: z.string().email(), role: z.enum(["ADMIN", "MANAGER", "SALES_STAFF"]),
  password: z.string().min(10), phone: z.string().optional(), teamName: z.string().optional(), managerUserId: z.string().uuid().optional() });
r.post("/", requireRole("ADMIN"), wrap(async (req, res) => {
  const d = parse(body, req.body);
  const u = await prisma.$transaction(async (tx) => {
    const mgr = d.managerUserId ? await tx.staffProfile.findUnique({ where: { userId: d.managerUserId } }) : null;
    const created = await tx.user.create({ data: { name: d.name, email: d.email.toLowerCase(), role: d.role, passwordHash: await bcrypt.hash(d.password, 12),
      profile: { create: { phone: d.phone, teamName: d.teamName, managerId: mgr?.id } } }, select });
    await audit(tx, req.user.id, "user.create", "user", created.id, { role: d.role });
    return created;
  });
  ok(res, u, undefined, 201);
}));
r.patch("/:id", requireRole("ADMIN"), wrap(async (req, res) => {
  const d = parse(z.object({ name: z.string().min(2), role: z.enum(["ADMIN", "MANAGER", "SALES_STAFF"]), isActive: z.boolean() }).partial(), req.body);
  if (req.params.id === req.user.id && d.isActive === false) throw new ApiError(400, "You cannot deactivate your own account");
  const u = await prisma.user.update({ where: { id: req.params.id }, data: d, select });
  await prisma.auditLog.create({ data: { userId: req.user.id, action: "user.update", entity: "user", entityId: u.id, meta: d } });
  ok(res, u);
}));
export default r;
