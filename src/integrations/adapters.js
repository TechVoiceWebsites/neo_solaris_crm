import crypto from "node:crypto";

const hmacOk = (secret, raw, sig) => {
  if (!secret || !sig || !raw) return false;
  const a = Buffer.from(crypto.createHmac("sha256", secret).update(raw).digest("hex"));
  const b = Buffer.from(String(sig).replace(/^sha256=/, ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

const cleanPhone = (phone) => (phone ? String(phone).replace(/\s+/g, "").trim() : "");

export const adapters = {
  WEBSITE: {
    name: "Website",
    configured: () => !!process.env.WEBSITE_WEBHOOK_SECRET,
    verify: (req) =>
      hmacOk(process.env.WEBSITE_WEBHOOK_SECRET, req.rawBody, req.headers["x-signature"]),
    normalize: (b) => ({
      externalId: b.submissionId || `web_${Date.now()}`,
      data: {
        customerName: b.name || b.fullName || "Website Visitor",
        phone: cleanPhone(b.phone || b.mobile),
        email: b.email || "",
        company: b.company || "",
        city: b.city || b.district || "",
        requirement: b.requirement || "Website Solar Enquiry",
        description: b.message || "",
        estimatedValue: Number(b.estimatedValue || 0),
      },
    }),
  },

  INDIAMART: {
    name: "IndiaMART",
    configured: () => !!process.env.INDIAMART_CRM_KEY,
    needs: "Official IndiaMART lead API key from the client",
    verify: (req) => {
      const key = process.env.INDIAMART_CRM_KEY;
      if (!key) return false;
      return req.headers["x-api-key"] === key || req.query.glusr_crm_key === key;
    },
    normalize: (b) => {
      // IndiaMART sends either single object or inside RESPONSE array
      const item = Array.isArray(b.RESPONSE) ? b.RESPONSE[0] : b;
      return {
        externalId: item.UNIQUE_QUERY_ID || `im_${Date.now()}`,
        data: {
          customerName: item.SENDER_NAME || item.sender_name || "IndiaMART Enquiry",
          phone: cleanPhone(item.SENDER_MOBILE || item.sender_mobile),
          email: item.SENDER_EMAIL || item.sender_email || "",
          company: item.SENDER_COMPANY || item.sender_company || "",
          city: item.SENDER_CITY || item.sender_city || "",
          requirement: item.SUBJECT || item.QUERY_PRODUCT_NAME || "IndiaMART Solar Enquiry",
          description: item.QUERY_MESSAGE || item.query_message || "",
          estimatedValue: Number(item.estimated_value || 0),
        },
      };
    },
  },

  PUREPOWER: {
    name: "PUREPower Referrals",
    configured: () => !!process.env.PUREPOWER_WEBHOOK_SECRET,
    needs: "Agreed referral data format and shared secret from PUREPower",
    verify: (req) =>
      hmacOk(process.env.PUREPOWER_WEBHOOK_SECRET, req.rawBody, req.headers["x-signature"]),
    normalize: (b) => ({
      externalId: b.referralId || `pp_${Date.now()}`,
      data: {
        customerName: b.customerName || b.name || "PuREPower Referral",
        phone: cleanPhone(b.mobile || b.phone),
        email: b.email || "",
        company: b.companyName || b.company || "",
        city: b.location || b.city || "",
        requirement: b.systemCapacity || b.requirement || "PuREPower BESS / Solar Referral",
        description: b.notes || b.description || "",
        estimatedValue: Number(b.estimatedValue || 0),
      },
    }),
  },

  META: {
    name: "Facebook / Instagram",
    configured: () => !!process.env.META_APP_SECRET,
    needs: "Meta app, Lead Ads webhook subscription and app secret",
    verify: (req) =>
      hmacOk(process.env.META_APP_SECRET, req.rawBody, req.headers["x-hub-signature-256"]),
    normalize: (b) => ({
      externalId: b.leadgen_id || `meta_${Date.now()}`,
      data: {
        customerName: b.full_name || b.name || "Social Media Lead",
        phone: cleanPhone(b.phone_number || b.phone),
        email: b.email || "",
        company: b.company_name || "",
        city: b.city || "",
        requirement: b.campaign_name || b.ad_name || b.requirement || "Meta Ad Campaign Lead",
        description: b.message || "",
        estimatedValue: Number(b.estimatedValue || 0),
      },
    }),
  },
};