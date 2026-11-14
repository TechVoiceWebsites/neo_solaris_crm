import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import rateLimit from "express-rate-limit";
import { prisma } from "../config/db.js";
import { wrap, ok, parse, ApiError } from "../utils/http.js";
import { signToken, authenticate } from "../middleware/auth.js";

const r = Router();
const pub = (u) => ({ id: u.id, name: u.name, email: u.email, role: u.role });
r.post("/login", rateLimit({ windowMs: 15 * 60000, limit: 20 }), wrap(async (req, res) => {
  const { email, password } = parse(z.object({ email: z.string().email(), password: z.string().min(1) }), req.body);
  const u = await prisma.user.findFirst({ where: { email: email.toLowerCase(), isActive: true, deletedAt: null } });
  // same message for unknown email and wrong password
  if (!u || !(await bcrypt.compare(password, u.passwordHash))) throw new ApiError(401, "Email or password is incorrect");
  await prisma.auditLog.create({ data: { userId: u.id, action: "auth.login", entity: "user", entityId: u.id } });
  ok(res, { token: signToken(u), user: pub(u) });
}));
r.get("/me", authenticate, (req, res) => ok(res, pub(req.user)));
r.post("/logout", authenticate, wrap(async (req, res) => {
  await prisma.auditLog.create({ data: { userId: req.user.id, action: "auth.logout", entity: "user", entityId: req.user.id } });
  ok(res, { loggedOut: true }); // client discards the 8-hour token
}));
r.post("/password", authenticate, wrap(async (req, res) => {
  const { current, next } = parse(z.object({ current: z.string(), next: z.string().min(10) }), req.body);
  if (!(await bcrypt.compare(current, req.user.passwordHash))) throw new ApiError(400, "Current password is incorrect");
  await prisma.user.update({ where: { id: req.user.id }, data: { passwordHash: await bcrypt.hash(next, 12) } });
  ok(res, { updated: true });
}));
export default r;
