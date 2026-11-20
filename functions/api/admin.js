function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const encoder = new TextEncoder();
  const bufA = encoder.encode(a);
  const bufB = encoder.encode(b);
  if (bufA.byteLength !== bufB.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < bufA.byteLength; i++) {
    diff |= bufA[i] ^ bufB[i];
  }
  return diff === 0;
}

export async function onRequestGet(context) {
  const { request, env } = context;

  if (!env.ADMIN_KEY) {
    return Response.json(
      { ok: false, error: "ADMIN_KEY secret is not configured in Cloudflare Pages." },
      { status: 500 }
    );
  }

  const url = new URL(request.url);
  const providedKey =
    request.headers.get("X-Admin-Key") || url.searchParams.get("key") || "";

  if (!timingSafeEqual(providedKey, env.ADMIN_KEY)) {
    return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  // 1. Handle R2 File Download
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

  // 2. List All Applications from D1
  try {
    const { results } = await env.DB.prepare(
      `SELECT id, submitted_at, applicant_name, applicant_email, applicant_phone,
              desired_move_in, file_key, file_name, payload_json
       FROM applications
       ORDER BY id DESC`
    ).all();

    return Response.json({ ok: true, applications: results || [] });
  } catch (err) {
    return Response.json(
      { ok: false, error: "Failed to query applications database." },
      { status: 500 }
    );
  }
}

export async function onRequestDelete(context) {
  const { request, env } = context;

  if (!env.ADMIN_KEY) {
    return Response.json({ ok: false, error: "ADMIN_KEY not configured." }, { status: 500 });
  }

  const providedKey = request.headers.get("X-Admin-Key") || "";
  if (!timingSafeEqual(providedKey, env.ADMIN_KEY)) {
    return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const id = Number(url.searchParams.get("id"));
  if (!id) {
    return Response.json({ ok: false, error: "Missing application ID." }, { status: 400 });
  }

  try {
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