const MAX_FILE_BYTES = 5 * 1024 * 1024;
const ALLOWED_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp"
]);

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const formData = await request.formData();

    if (formData.get("botcheck")) {
      return Response.json({ ok: true });
    }

    const applicantName = String(formData.get("Applicant_Full_Name") || "").trim();
    const applicantEmail = String(formData.get("Email") || "").trim();
    const applicantPhone = String(formData.get("Phone") || "").trim();
    const desiredMoveIn = String(formData.get("Desired_Move_In_Date") || "").trim();

    if (!applicantName || !applicantEmail || !applicantPhone || !desiredMoveIn) {
      return Response.json(
        { ok: false, error: "Missing required applicant fields." },
        { status: 400 }
      );
    }

    let fileKey = null;
    let fileName = null;
    const uploaded = formData.get("supporting_doc");

    if (uploaded && typeof uploaded === "object" && uploaded.size > 0) {
      if (!ALLOWED_TYPES.has(uploaded.type)) {
        return Response.json(
          { ok: false, error: "Unsupported file type. Please upload a PDF, JPG, PNG, or WEBP." },
          { status: 400 }
        );
      }
      if (uploaded.size > MAX_FILE_BYTES) {
        return Response.json(
          { ok: false, error: "File exceeds the 5 MB size limit." },
          { status: 400 }
        );
      }

      const safeName = uploaded.name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100);
      fileKey = `applications/${Date.now()}-${crypto.randomUUID()}-${safeName}`;
      fileName = safeName;

      await env.DOCS_BUCKET.put(fileKey, await uploaded.arrayBuffer(), {
        httpMetadata: { contentType: uploaded.type }
      });
    }

    const fields = {};
    for (const [key, value] of formData.entries()) {
      if (key === "botcheck" || key === "supporting_doc") continue;
      if (typeof value === "string") {
        fields[key] = value;
      }
    }

    const submittedAt = new Date().toISOString();

    await env.DB.prepare(
      `INSERT INTO applications (
        submitted_at, applicant_name, applicant_email, applicant_phone,
        desired_move_in, file_key, file_name, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        submittedAt,
        applicantName,
        applicantEmail,
        applicantPhone,
        desiredMoveIn,
        fileKey,
        fileName,
        JSON.stringify(fields)
      )
      .run();

    return Response.json({ ok: true, submittedAt });
  } catch (err) {
    return Response.json(
      { ok: false, error: "Unable to process submission right now." },
      { status: 500 }
    );
  }
}