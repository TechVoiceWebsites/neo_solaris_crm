import { z } from "zod";
import { prisma } from "../config/db.js";
import { ApiError } from "../utils/http.js";
import { env } from "../config/env.js";

export const normPhone = (p) => { const d = String(p).replace(/\D/g, ""); return d.length >= 10 ? d.slice(-10) : null; };
export const leadInput = z.object({
  customerName: z.string().trim().min(2).max(120),
  phone: z.string().refine((v) => /^[6-9]\d{9}$/.test(normPhone(v) || ""), "Enter a valid 10-digit Indian mobile number"),
  email: z.string().email().optional().or(z.literal("")),
  company: z.string().max(160).optional(), city: z.string().max(80).optional(),
  requirement: z.string().max(200).optional(), description: z.string().max(2000).optional(),
  priority: z.enum(["LOW", "MEDIUM", "HIGH"]).optional(),
  estimatedValue: z.coerce.number().nonnegative().optional(),
});

export async function audit(tx, userId, action, entity, entityId, meta) {
  await tx.auditLog.create({ data: { userId, action, entity, entityId, meta } });
}

// Creates a lead after duplicate checks. Returns { lead, duplicate }.
export async function createLead({ data, sourceCode, externalId, createdById }) {
  const phone = normPhone(data.phone);
  const source = await prisma.leadSource.findUnique({ where: { code: sourceCode } });
  if (!source) throw new ApiError(400, "Unknown lead source");
  const first = await prisma.pipelineStage.findFirst({ orderBy: { position: "asc" } });
  const dup = await prisma.lead.findFirst({
    where: { deletedAt: null, status: "OPEN", OR: [{ phone }, ...(externalId ? [{ sourceId: source.id, externalId }] : [])] },
  });
  if (dup) return { lead: dup, duplicate: true };

  const actorId = createdById ?? (await systemUserId(prisma));
  const lead = await prisma.lead.create({
    data: {
      sourceId: source.id, externalId, customerName: data.customerName, phone, email: data.email || null, company: data.company,
      city: data.city, requirement: data.requirement, description: data.description, priority: data.priority ?? "MEDIUM",
      estimatedValue: data.estimatedValue, stageId: first.id, createdById,
    },
  });

  await prisma.$transaction([
    prisma.leadStageHistory.create({ data: { leadId: lead.id, toStageId: first.id, changedById: actorId, reason: "Lead created" } }),
    prisma.auditLog.create({ data: { userId: createdById, action: "lead.create", entity: "lead", entityId: lead.id, meta: { source: sourceCode } } }),
  ]);

  return { lead, duplicate: false };
}

async function systemUserId(db = prisma) {
  return (await db.user.findFirst({ where: { role: "ADMIN", isActive: true }, orderBy: { createdAt: "asc" } }))?.id;
}

export async function pickRoundRobin(db, candidateIds) {
  if (!candidateIds.length) throw new ApiError(409, "No active sales staff available");
  const last = await db.leadAssignment.groupBy({ by: ["assignedToId"], where: { assignedToId: { in: candidateIds } }, _max: { assignedAt: true } });
  const m = new Map(last.map((r) => [r.assignedToId, r._max.assignedAt?.getTime() ?? 0]));
  return [...candidateIds].sort((a, b) => (m.get(a) ?? 0) - (m.get(b) ?? 0))[0];
}

// Append-only history: reassignment adds a row; old rows are never changed.
export async function assignLead(db, { leadId, assigneeId, byId, note }) {
  const [lead] = await prisma.$transaction([
    prisma.lead.update({ where: { id: leadId }, data: { currentOwnerId: assigneeId } }),
    prisma.leadAssignment.create({ data: { leadId, assignedToId: assigneeId, assignedById: byId, note } }),
    prisma.auditLog.create({ data: { userId: byId, action: "lead.assign", entity: "lead", entityId: leadId, meta: { assigneeId } } }),
  ]);
  return lead;
}

export async function autoAllocateIfEnabled(lead) {
  if (env.allocationMode !== "round_robin") return lead;
  const admin = await prisma.user.findFirst({ where: { role: "ADMIN", isActive: true }, orderBy: { createdAt: "asc" } });
  if (!admin) return lead;
  const staff = await prisma.user.findMany({
    where: { role: "SALES_STAFF", isActive: true, deletedAt: null },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
  if (!staff.length) return lead;
  const pick = await pickRoundRobin(prisma, staff.map((s) => s.id));
  return assignLead(prisma, { leadId: lead.id, assigneeId: pick, byId: admin.id, note: "Auto round-robin" });
}