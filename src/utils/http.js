export class ApiError extends Error {
  constructor(status, message, details) { super(message); this.status = status; this.details = details; }
}
export const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
export const ok = (res, data, meta, status = 200) => res.status(status).json({ success: true, data, ...(meta && { meta }) });
export const parse = (schema, data) => {
  const r = schema.safeParse(data);
  if (!r.success) throw new ApiError(422, "Validation failed", r.error.flatten().fieldErrors);
  return r.data;
};
export const page = (q) => {
  const p = Math.max(1, Number(q.page) || 1), size = Math.min(100, Number(q.pageSize) || 20);
  return { skip: (p - 1) * size, take: size, p, size };
};
// Asia/Kolkata (UTC+5:30, no DST) day boundaries, returned as UTC Dates
const IST = 330 * 60000;
export const istDayStart = (d = new Date()) => new Date(Math.floor((d.getTime() + IST) / 86400000) * 86400000 - IST);
