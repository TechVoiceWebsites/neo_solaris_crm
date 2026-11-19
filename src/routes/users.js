import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "../config/db.js";
import { wrap, ok, parse, ApiError } from "../utils/http.js";
import { requireRole } from "../middleware/auth.js";
import { audit } from "../services/leadService.js";

const r = Router();
const select = {
  id: true,
  name: true,
  email: true,
  role: true,
  isActive: true,
  profile: { select: { phone: true, teamName: true, managerId: true } },
};

r.get("/", requireRole("ADMIN", "MANAGER"), wrap(async (req, res) => {
  const where = {
    deletedAt: null,
    ...(req.user.role === "MANAGER" && {
      OR: [{ id: req.user.id }, { profile: { manager: { userId: req.user.id } } }],
    }),
  };
  ok(res, await prisma.user.findMany({ where, select, orderBy: { name: "asc" } }));
}));

const body = z.object({
  name: z.string().trim().min(2),
  email: z.string().trim().email(),
  role: z.enum(["ADMIN", "MANAGER", "SALES_STAFF"]),
  password: z.string().min(8),
  phone: z.string().trim().optional(),
  teamName: z.string().trim().optional(),
  managerUserId: z.string().uuid().optional(),
});

r.post("/", requireRole("ADMIN"), wrap(async (req, res) => {
  const d = parse(body, req.body);
  const normalizedEmail = d.email.toLowerCase();

  const [exists, passwordHash, mgr] = await Promise.all([
    prisma.user.findUnique({ where: { email: normalizedEmail }, select: { id: true } }),
    bcrypt.hash(d.password, 10),
    d.managerUserId
      ? prisma.staffProfile.findUnique({ where: { userId: d.managerUserId }, select: { id: true } })
      : null,
  ]);
  if (exists) throw new ApiError(409, "An account with this email already exists");

  const created = await prisma.user.create({
    data: {
      name: d.name,
      email: normalizedEmail,
      role: d.role,
      passwordHash,
      profile: { create: { phone: d.phone || null, teamName: d.teamName, managerId: mgr?.id } },
    },
    select,
  });

  // Fire-and-forget audit log so response returns immediately
  prisma.auditLog
    .create({
      data: {
        userId: req.user.id,
        action: "user.create",
        entity: "user",
        entityId: created.id,
        meta: { role: d.role },
      },
    })
    .catch(() => {});

  ok(res, created, undefined, 201);
}));

const updateBody = z.object({
  name: z.string().trim().min(2).optional(),
  email: z.string().trim().email().optional(),
  role: z.enum(["ADMIN", "MANAGER", "SALES_STAFF"]).optional(),
  phone: z.string().trim().nullable().optional(),
  password: z.string().min(8).optional(),
  isActive: z.boolean().optional(),
});

r.patch("/:id", requireRole("ADMIN"), wrap(async (req, res) => {
  const d = parse(updateBody, req.body);
  if (req.params.id === req.user.id && d.isActive === false) {
    throw new ApiError(400, "You cannot deactivate your own account");
  }

  const target = await prisma.user.findFirst({ where: { id: req.params.id, deletedAt: null } });
  if (!target) throw new ApiError(404, "Staff member not found");

  if (d.email && d.email.toLowerCase() !== target.email) {
    const dup = await prisma.user.findUnique({ where: { email: d.email.toLowerCase() } });
    if (dup) throw new ApiError(409, "Another account already uses this email");
  }

  const data = {
    ...(d.name !== undefined && { name: d.name }),
    ...(d.email !== undefined && { email: d.email.toLowerCase() }),
    ...(d.role !== undefined && { role: d.role }),
    ...(d.isActive !== undefined && { isActive: d.isActive }),
    ...(d.password && { passwordHash: await bcrypt.hash(d.password, 10) }),
    ...(d.phone !== undefined && {
      profile: {
        upsert: {
          create: { phone: d.phone || null },
          update: { phone: d.phone || null },
        },
      },
    }),
  };

  const u = await prisma.user.update({ where: { id: req.params.id }, data, select });
  prisma.auditLog
    .create({
      data: {
        userId: req.user.id,
        action: "user.update",
        entity: "user",
        entityId: u.id,
        meta: { name: d.name, email: d.email, role: d.role },
      },
    })
    .catch(() => {});

  ok(res, u);
}));

r.delete("/:id", requireRole("ADMIN"), wrap(async (req, res) => {
  if (req.params.id === req.user.id) {
    throw new ApiError(400, "You cannot delete your own account");
  }

  const target = await prisma.user.findFirst({ where: { id: req.params.id, deletedAt: null } });
  if (!target) throw new ApiError(404, "Staff member not found");

  await prisma.$transaction(async (tx) => {
    await Promise.all([
      tx.lead.updateMany({
        where: { currentOwnerId: target.id, status: "OPEN" },
        data: { currentOwnerId: null },
      }),
      tx.user.update({
        where: { id: target.id },
        data: {
          isActive: false,
          deletedAt: new Date(),
          email: `${target.email}.deleted.${Date.now()}`,
        },
      }),
      audit(tx, req.user.id, "user.delete", "user", target.id, { name: target.name }),
    ]);
  }, { timeout: 15000, maxWait: 10000 });

  ok(res, { deleted: true });
}));

export default r;