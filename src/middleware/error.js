import { ApiError } from "../utils/http.js";
export const notFound = (_req, _res, next) => next(new ApiError(404, "Not found"));
export const errorHandler = (err, _req, res, _next) => {
  if (err instanceof ApiError) return res.status(err.status).json({ success: false, message: err.message, details: err.details });
  if (err?.code === "P2002") return res.status(409).json({ success: false, message: "Record already exists" });
  console.error(err); // full detail stays in server logs only
  res.status(500).json({ success: false, message: "Something went wrong on the server" });
};
