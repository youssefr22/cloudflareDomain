const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5 MB per file
const ALLOWED_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp"
]);

async function saveUploadToR2(bucket, file, prefix) {
  if (!file || typeof file !== "object" || file.size === 0) {
    return { key: null, name: null };
  }
  if (!ALLOWED_TYPES.has(file.type)) {
    throw new Error("Unsupported file type. Please upload a PDF, JPG, PNG, or WEBP.");
  }
  if (file.size > MAX_FILE_BYTES) {
    throw new Error("Each file must be 5 MB or smaller.");
  }

  const safeName = String(file.name || "document")
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .slice(0, 100);
  const key = `applications/${prefix}/${Date.now()}-${crypto.randomUUID()}-${safeName}`;

  await bucket.put(key, await file.arrayBuffer(), {
    httpMetadata: { contentType: file.type }
  });

  return { key, name: safeName };
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const refId = Number(url.searchParams.get("ref"));

  if (!Number.isInteger(refId) || refId <= 0 || !env.DB) {
    return Response.json({ ok: false, error: "Invalid reference." }, { status: 400 });
  }

  try {
    const row = await env.DB.prepare(
      "SELECT id, applicant_name, desired_move_in, stage FROM applications WHERE id = ?"
    )
      .bind(refId)
      .first();

    if (!row) {
      return Response.json({ ok: false, error: "Reference not found." }, { status: 404 });
    }

    return Response.json({
      ok: true,
      reference: {
        id: row.id,
        applicant_name: row.applicant_name,
        desired_move_in: row.desired_move_in,
        stage: row.stage
      }
    });
  } catch (err) {
    return Response.json({ ok: false, error: err?.message || "Lookup failed." }, { status: 500 });
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    if (!env.DB || !env.DOCS_BUCKET) {
      return Response.json(
        { ok: false, error: "Server storage bindings (DB or DOCS_BUCKET) are not configured." },
        { status: 500 }
      );
    }

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
        { ok: false, error: "Please fill out your name, phone, email, and desired move-in date." },
        { status: 400 }
      );
    }

    const rawStage = String(formData.get("Application_Stage") || "initial").toLowerCase();
    const stage = rawStage === "full" ? "full" : "initial";
    const rawParentId = Number(formData.get("Parent_Application_ID"));
    const parentApplicationId = Number.isInteger(rawParentId) && rawParentId > 0 ? rawParentId : null;

    const payStubUpload = await saveUploadToR2(env.DOCS_BUCKET, formData.get("pay_stub_doc"), "pay-stubs");
    const voucherUpload = await saveUploadToR2(env.DOCS_BUCKET, formData.get("voucher_doc"), "vouchers");

    const storedFiles = [payStubUpload.key, voucherUpload.key].filter(Boolean).join(", ") || null;
    const storedNames = [
      payStubUpload.name ? `PayStub: ${payStubUpload.name}` : null,
      voucherUpload.name ? `Voucher: ${voucherUpload.name}` : null
    ]
      .filter(Boolean)
      .join(" | ") || null;

    const fields = {};
    for (const [key, value] of formData.entries()) {
      if (key === "botcheck" || key === "pay_stub_doc" || key === "voucher_doc") continue;
      if (typeof value === "string") {
        fields[key] = value;
      }
    }
    fields.Application_Stage = stage;
    if (parentApplicationId) fields.Parent_Application_ID = String(parentApplicationId);
    if (payStubUpload.key) fields.Pay_Stub_R2_Key = payStubUpload.key;
    if (voucherUpload.key) fields.Voucher_Doc_R2_Key = voucherUpload.key;

    const submittedAt = new Date().toISOString();

    const insertResult = await env.DB.prepare(
      `INSERT INTO applications (
        submitted_at, applicant_name, applicant_email, applicant_phone,
        desired_move_in, file_key, file_name, payload_json, stage, parent_application_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        submittedAt,
        applicantName,
        applicantEmail,
        applicantPhone,
        desiredMoveIn,
        storedFiles,
        storedNames,
        JSON.stringify(fields),
        stage,
        parentApplicationId
      )
      .run();

    const newId = insertResult?.meta?.last_row_id ?? null;

    return Response.json({
      ok: true,
      id: newId,
      stage,
      parentApplicationId,
      submittedAt
    });
  } catch (err) {
    const msg = err && err.message ? err.message : "Unable to process submission right now.";
    const isClientFileError = msg.startsWith("Unsupported file type") || msg.startsWith("Each file must be");
    return Response.json(
      { ok: false, error: msg },
      { status: isClientFileError ? 400 : 500 }
    );
  }
}