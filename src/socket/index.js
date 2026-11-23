import { Server } from "socket.io";
import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
import { prisma } from "../config/db.js";

let io;

export function initSocket(server) {
  const allowedOrigins = [
    "http://localhost:5173",
    "http://localhost:5174",
    "https://neo-solaris-crm.netlify.app",
    ...(env.frontendUrl ? env.frontendUrl.split(",") : []),
  ]
    .map((url) => url.trim().replace(/\/$/, ""))
    .filter(Boolean);

  io = new Server(server, {
    cors: {
      origin: allowedOrigins,
      credentials: true,
    },
  });

  io.use(async (socket, next) => {
    try {
      const id = jwt.verify(socket.handshake.auth?.token, env.jwtSecret).sub;
      const u = await prisma.user.findFirst({
        where: { id, isActive: true, deletedAt: null },
      });
      if (!u) return next(new Error("unauthorized"));
      socket.join(`user:${u.id}`);
      socket.join(`role:${u.role}`);
      if (u.role === "MANAGER") socket.join(`team:${u.id}`);
      next();
    } catch {
      next(new Error("unauthorized"));
    }
  });
}

// Called only AFTER the database transaction has committed. Sends ids only;
// clients re-fetch through the authorized API, so no lead data is broadcast.
export async function emitLead(event, lead, extra = {}) {
  if (!io) return;
  const rooms = ["role:ADMIN"];
  if (lead.currentOwnerId) {
    rooms.push(`user:${lead.currentOwnerId}`);
    const p = await prisma.staffProfile.findUnique({
      where: { userId: lead.currentOwnerId },
      include: { manager: true },
    });
    if (p?.manager) rooms.push(`team:${p.manager.userId}`);
  }
  io.to(rooms).emit(event, { leadId: lead.id, ...extra });
  io.to(rooms).emit("dashboard:changed", { reason: event });
}

export const emitTo = (room, event, payload) =>
  io?.to(room).emit(event, payload);