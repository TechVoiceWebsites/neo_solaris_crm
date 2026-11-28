
const need = (k) => {
  if (!process.env[k]) throw new Error(`Missing env var ${k}`);
  return process.env[k];
};

export const env = {
  port: Number(process.env.PORT || 4000),
  jwtSecret: need("JWT_SECRET"),
  frontendUrl: process.env.FRONTEND_URL || "http://localhost:5173",
  prod: process.env.NODE_ENV === "production",
  allocationMode: process.env.ALLOCATION_MODE || "manual",

  // Supabase Storage
  supabaseUrl: process.env.SUPABASE_URL || "",
  supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || "",
};