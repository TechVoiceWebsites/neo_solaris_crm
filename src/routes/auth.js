import { Router } from "express";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import nodemailer from "nodemailer";
import { z } from "zod";
import rateLimit from "express-rate-limit";
import { prisma } from "../config/db.js";
import { wrap, ok, parse, ApiError } from "../utils/http.js";
import { signToken, authenticate } from "../middleware/auth.js";

const r = Router();
const pub = (u) => ({ id: u.id, name: u.name, email: u.email, role: u.role });

// In-memory OTP store: email -> { otpHash, expiresAt, verified, attempts }
const otpStore = new Map();

function getMailer() {
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) return null;
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST || "smtp.gmail.com",
    port: Number(process.env.SMTP_PORT || 465),
    secure: Number(process.env.SMTP_PORT || 465) === 465,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}

async function sendOtpEmail(toEmail, userName, otp) {
  const transporter = getMailer();
  if (!transporter) {
    console.log(`\n[DEV OTP] Password reset OTP for ${toEmail}: ${otp}\n`);
    return;
  }
  await transporter.sendMail({
    from: `"Neo Solaris CRM" <${process.env.SMTP_USER}>`,
    to: toEmail,
    subject: "Neo Solaris CRM — Password Reset OTP",
    html: `
      <div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;padding:24px;border:1px solid #e1e6dc;border-radius:12px;">
        <h2 style="color:#0F1B3D;margin:0 0 8px;">Password Reset Request</h2>
        <p style="color:#5B6580;font-size:14px;">Hi ${userName || "User"}, use the OTP below to reset your Neo Solaris CRM password. It expires in 10 minutes.</p>
        <div style="margin:20px 0;padding:14px;background:#F4F6F1;border-radius:10px;text-align:center;font-size:28px;font-weight:bold;letter-spacing:6px;color:#3A7D1F;">
          ${otp}
        </div>
        <p style="color:#8A93A8;font-size:12px;">If you did not request this, you can safely ignore this email.</p>
      </div>
    `,
  });
}

// 1. Login
r.post("/login", rateLimit({ windowMs: 15 * 60000, limit: 20 }), wrap(async (req, res) => {
  const { email, password } = parse(z.object({ email: z.string().email(), password: z.string().min(1) }), req.body);
  const u = await prisma.user.findFirst({ where: { email: email.toLowerCase(), isActive: true, deletedAt: null } });
  if (!u || !(await bcrypt.compare(password, u.passwordHash))) throw new ApiError(401, "Email or password is incorrect");
  await prisma.auditLog.create({ data: { userId: u.id, action: "auth.login", entity: "user", entityId: u.id } });
  ok(res, { token: signToken(u), user: pub(u) });
}));

// 2. Register / Create Admin or Sales Person Account
r.post("/register", rateLimit({ windowMs: 15 * 60000, limit: 15 }), wrap(async (req, res) => {
  const body = parse(
    z.object({
      name: z.string().trim().min(2, "Name must be at least 2 characters"),
      email: z.string().trim().email("Enter a valid email"),
      password: z.string().min(8, "Password must be at least 8 characters"),
      role: z.enum(["ADMIN", "SALES_STAFF"]),
      phone: z.string().trim().optional(),
      teamName: z.string().trim().optional(),
    }),
    req.body
  );

  const normalizedEmail = body.email.toLowerCase();
  const exists = await prisma.user.findUnique({ where: { email: normalizedEmail } });
  if (exists) throw new ApiError(409, "An account with this email already exists");

  const passwordHash = await bcrypt.hash(body.password, 12);
  const created = await prisma.user.create({
    data: {
      name: body.name,
      email: normalizedEmail,
      passwordHash,
      role: body.role,
      isActive: true,
      profile: {
        create: {
          phone: body.phone || null,
          teamName: body.teamName || (body.role === "SALES_STAFF" ? "Sales Team" : "Administration"),
        },
      },
    },
  });

  await prisma.auditLog.create({
    data: { userId: created.id, action: "auth.register", entity: "user", entityId: created.id, meta: { role: body.role } },
  });

  ok(res, { token: signToken(created), user: pub(created) }, 201);
}));

// 3. Forgot Password -> Send 6-digit OTP to Email
r.post("/forgot-password", rateLimit({ windowMs: 15 * 60000, limit: 10 }), wrap(async (req, res) => {
  const { email, role } = parse(
    z.object({
      email: z.string().trim().email("Enter a valid registered email"),
      role: z.enum(["ADMIN", "SALES_STAFF"]).optional(),
    }),
    req.body
  );

  const normalizedEmail = email.toLowerCase();
  const u = await prisma.user.findFirst({
    where: { email: normalizedEmail, isActive: true, deletedAt: null },
  });

  if (!u) throw new ApiError(404, "No active account found with this email");
  if (role && u.role !== role) {
    throw new ApiError(
      400,
      u.role === "ADMIN"
        ? "This is an Admin email. Switch to Admin tab to reset password."
        : "This is a Sales Person email. Switch to Sales Person tab to reset password."
    );
  }

  const otp = String(crypto.randomInt(100000, 999999));
  const otpHash = await bcrypt.hash(otp, 10);
  otpStore.set(normalizedEmail, {
    otpHash,
    expiresAt: Date.now() + 10 * 60 * 1000, // 10 mins
    verified: false,
    attempts: 0,
  });

  await sendOtpEmail(normalizedEmail, u.name, otp);
  ok(res, { sent: true, message: "6-digit OTP sent to your email" });
}));

// 4. Verify OTP
r.post("/verify-otp", rateLimit({ windowMs: 15 * 60000, limit: 20 }), wrap(async (req, res) => {
  const { email, otp } = parse(
    z.object({
      email: z.string().trim().email(),
      otp: z.string().trim().length(6, "OTP must be 6 digits"),
    }),
    req.body
  );

  const normalizedEmail = email.toLowerCase();
  const record = otpStore.get(normalizedEmail);
  if (!record) throw new ApiError(400, "No OTP requested or OTP expired. Please request a new one.");
  if (Date.now() > record.expiresAt) {
    otpStore.delete(normalizedEmail);
    throw new ApiError(400, "OTP has expired. Please request a new one.");
  }
  if (record.attempts >= 5) {
    otpStore.delete(normalizedEmail);
    throw new ApiError(429, "Too many invalid attempts. Request a new OTP.");
  }

  const valid = await bcrypt.compare(otp, record.otpHash);
  if (!valid) {
    record.attempts += 1;
    throw new ApiError(400, "Invalid OTP. Please check and try again.");
  }

  record.verified = true;
  ok(res, { verified: true });
}));

// 5. Reset Password (after OTP verified)
r.post("/reset-password", rateLimit({ windowMs: 15 * 60000, limit: 15 }), wrap(async (req, res) => {
  const { email, otp, newPassword } = parse(
    z.object({
      email: z.string().trim().email(),
      otp: z.string().trim().length(6),
      newPassword: z.string().min(8, "New password must be at least 8 characters"),
    }),
    req.body
  );

  const normalizedEmail = email.toLowerCase();
  const record = otpStore.get(normalizedEmail);
  if (!record || !record.verified || Date.now() > record.expiresAt) {
    throw new ApiError(400, "OTP session expired. Please verify OTP again.");
  }

  const valid = await bcrypt.compare(otp, record.otpHash);
  if (!valid) throw new ApiError(400, "Invalid OTP");

  const u = await prisma.user.findFirst({ where: { email: normalizedEmail, isActive: true, deletedAt: null } });
  if (!u) throw new ApiError(404, "User not found");

  await prisma.user.update({
    where: { id: u.id },
    data: { passwordHash: await bcrypt.hash(newPassword, 12) },
  });

  otpStore.delete(normalizedEmail);
  await prisma.auditLog.create({ data: { userId: u.id, action: "auth.password_reset", entity: "user", entityId: u.id } });
  ok(res, { reset: true });
}));

r.get("/me", authenticate, (req, res) => ok(res, pub(req.user)));
r.post("/logout", authenticate, wrap(async (req, res) => {
  await prisma.auditLog.create({ data: { userId: req.user.id, action: "auth.logout", entity: "user", entityId: req.user.id } });
  ok(res, { loggedOut: true });
}));
r.post("/password", authenticate, wrap(async (req, res) => {
  const { current, next } = parse(z.object({ current: z.string(), next: z.string().min(10) }), req.body);
  if (!(await bcrypt.compare(current, req.user.passwordHash))) throw new ApiError(400, "Current password is incorrect");
  await prisma.user.update({ where: { id: req.user.id }, data: { passwordHash: await bcrypt.hash(next, 12) } });
  ok(res, { updated: true });
}));

export default r;