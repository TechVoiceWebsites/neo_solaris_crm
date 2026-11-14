import { prisma } from "../config/db.js";
import { ApiError } from "../utils/http.js";
// Single source of truth for "which leads may this user see".
export async function teamUserIds(user) {
  const rows = await prisma.staffProfile.findMany({ where: { manager: { userId: user.id } }, select: { userId: true } });
  return [user.id, ...rows.map((r) => r.userId)];
}
export async function leadScope(user) {
  if (user.role === "ADMIN") return { deletedAt: null };
  if (user.role === "MANAGER") return { deletedAt: null, currentOwnerId: { in: await teamUserIds(user) } };
  return { deletedAt: null, currentOwnerId: user.id };
}
export async function getLeadOr404(user, id) {
  const lead = await prisma.lead.findFirst({ where: { id, ...(await leadScope(user)) } });
  if (!lead) throw new ApiError(404, "Lead not found"); // 404, not 403: do not reveal other staff's leads exist
  return lead;
}
