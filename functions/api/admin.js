const TEAM_DOMAIN = "https://yoabra.cloudflareaccess.com";
const ALLOWED_EMAILS = new Set([
  "yoabrallc@gmail.com",
  "rafeh.youssef@gmail.com",
  "youssef@yoabra.com"
]);

let cachedKeys = null;
let cachedAt = 0;

function base64UrlToUint8Array(base64Url) {
  const padding = "=".repeat((4 - (base64Url.length % 4)) % 4);
  const base64 = (base64Url + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    bytes[i] = raw.charCodeAt(i);
  }
  return bytes;
}

async function getAccessPublicKeys() {
  const now = Date.now();
  if (cachedKeys && now - cachedAt < 10 * 60 * 1000) {
    return cachedKeys;
  }
  const res = await fetch(`${TEAM_DOMAIN}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error("Failed to fetch Cloudflare Access certs");
  const data = await res.json();
  cachedKeys = data.keys || [];
  cachedAt = now;
  return cachedKeys;
}

async function verifyAccessJwt(request, env) {
  if (!env.POLICY_AUD) {
    throw new Error("POLICY_AUD is not configured.");
  }

  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) return null;

  const parts = token.split(".");
  if (parts.length !== 3) return null;

  const [headerB64, payloadB64, signatureB64] = parts;
  const header = JSON.parse(new TextDecoder().decode(base64UrlToUint8Array(headerB64)));
  const payload = JSON.parse(new TextDecoder().decode(base64UrlToUint8Array(payloadB64)));

  const nowSec = Math.floor(Date.now() / 1000);
  if (payload.iss !== TEAM_DOMAIN) return null;
  if (payload.exp && payload.exp < nowSec) return null;

  const audList = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!audList.includes(env.POLICY_AUD)) return null;

  const keys = await getAccessPublicKeys();
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) return null;

  const cryptoKey = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"]
  );

  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    base64UrlToUint8Array(signatureB64),
    new TextEncoder().encode(`${headerB64}.${payloadB64}`)
  );

  if (!valid) return null;

  const email = String(payload.email || "").toLowerCase();
  if (!ALLOWED_EMAILS.has(email)) return null;

  return email;
}

export async function onRequestGet(context) {
  const { request, env } = context;

  try {
    const email = await verifyAccessJwt(request, env);
    if (!email) {
      return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }

    const url = new URL(request.url);
    const downloadKey = url.searchParams.get("download");

    if (downloadKey) {
      if (!downloadKey.startsWith("applications/")) {
        return Response.json({ ok: false, error: "Invalid file path." }, { status: 400 });
      }

      const object = await env.DOCS_BUCKET.get(downloadKey);
      if (!object) {
        return Response.json({ ok: false, error: "File not found in R2." }, { status: 404 });
      }

      const headers = new Headers();
      object.writeHttpMetadata(headers);
      headers.set("etag", object.httpEtag);
      const filename = downloadKey.split("/").pop() || "attachment";
      headers.set("Content-Disposition", `inline; filename="${filename}"`);

      return new Response(object.body, { headers });
    }

    const { results } = await env.DB.prepare(
      `SELECT id, submitted_at, applicant_name, applicant_email, applicant_phone,
              desired_move_in, file_key, file_name, payload_json, stage, parent_application_id
       FROM applications
       ORDER BY id DESC`
    ).all();

    return Response.json({ ok: true, user: email, applications: results || [] });
  } catch (err) {
    return Response.json(
      { ok: false, error: err.message || "Admin request failed." },
      { status: 500 }
    );
  }
}

export async function onRequestDelete(context) {
  const { request, env } = context;

  try {
    const email = await verifyAccessJwt(request, env);
    if (!email) {
      return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }

    const url = new URL(request.url);
    const id = Number(url.searchParams.get("id"));
    if (!id) {
      return Response.json({ ok: false, error: "Missing application ID." }, { status: 400 });
    }

    const row = await env.DB.prepare("SELECT file_key FROM applications WHERE id = ?")
      .bind(id)
      .first();

    if (row && row.file_key) {
      const keys = row.file_key.split(",").map((k) => k.trim()).filter(Boolean);
      for (const key of keys) {
        await env.DOCS_BUCKET.delete(key);
      }
    }

    await env.DB.prepare("DELETE FROM applications WHERE id = ?").bind(id).run();
    return Response.json({ ok: true });
  } catch (err) {
    return Response.json({ ok: false, error: "Failed to delete application." }, { status: 500 });
  }
}