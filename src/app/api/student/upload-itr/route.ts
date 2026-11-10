import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

/**
 * ITR upload helper for /student/apply.
 *
 * The "itr-documents" storage bucket cannot get a new RLS policy from the SQL
 * Editor (storage.objects is owned by supabase_storage_admin -> error 42501),
 * so instead of uploading directly the student asks this route for a
 * one-time SIGNED UPLOAD URL. The route signs it with the service-role key
 * (which bypasses storage RLS), then the browser sends the file straight to
 * Supabase Storage — the file body never passes through the server, so the
 * 10 MB limit still applies without any serverless body-size issues.
 *
 * The folder is always derived server-side from the logged-in student, so a
 * student can only ever sign a path under their own student_id.
 */
const BUCKET = "itr-documents";
const MAX_BYTES = 10 * 1024 * 1024;
const IMAGE_OR_PDF = /\.(jpe?g|png|webp|gif|bmp|avif|svg|heic|heif|jfif|tif|tiff|ico|pdf)$/;

function cookieName() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const match = url.match(/https?:\/\/([^./]+)/);
  return `sb-${match ? match[1] : "xflsxzmniseetvkrddmj"}-auth-token`;
}

function getToken(req: Request): string | null {
  const header = req.headers.get("authorization");
  if (header?.toLowerCase().startsWith("bearer ")) return header.slice(7);
  const cookie = req.headers.get("cookie");
  if (!cookie) return null;
  for (const part of cookie.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === cookieName()) {
      try {
        const raw = decodeURIComponent(rest.join("="));
        const parsed = JSON.parse(raw);
        if (parsed?.access_token) return parsed.access_token;
      } catch {
        return rest.join("=");
      }
    }
  }
  return null;
}

async function assertStudent(req: Request) {
  const token = getToken(req);
  if (!token) return "Not authenticated.";

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  const svc = createClient(url, anon, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data, error } = await svc.auth.getUser();
  if (error || !data.user) return "Session expired. Please log in again.";

  const { data: row, error: roleErr } = await svc
    .from("users")
    .select("user_id, role")
    .eq("auth_user_id", data.user.id)
    .maybeSingle();

  if (roleErr) return "Could not verify your account.";
  if (!row) return "Account not found.";

  // Students (and admins testing as themselves) — never trust a client-sent path.
  const { data: acct, error: acctErr } = await svc
    .from("student_accounts")
    .select("student_id")
    .eq("user_id", row.user_id)
    .maybeSingle();

  if (acctErr) return "Could not read your student account.";
  if (!acct) return "No student account is linked to this login.";

  return { userId: row.user_id as number, studentId: Number(acct.student_id) };
}

function serviceClient() {
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) return null;
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** POST — issue a signed upload URL for this student's ITR folder. */
export async function POST(req: Request) {
  try {
    const auth = await assertStudent(req);
    if (typeof auth === "string") {
      return NextResponse.json({ error: auth }, { status: 401 });
    }

    const body = (await req.json().catch(() => null)) as {
      file_name?: string;
      content_type?: string;
      size?: number;
    } | null;

    const fileName = String(body?.file_name || "").trim();
    if (!fileName) {
      return NextResponse.json({ error: "A file name is required." }, { status: 400 });
    }

    const size = Number(body?.size);
    if (Number.isFinite(size) && size > MAX_BYTES) {
      return NextResponse.json({ error: "File must be 10 MB or smaller." }, { status: 413 });
    }

    const contentType = String(body?.content_type || "").toLowerCase();
    const lower = fileName.toLowerCase();
    const ok = contentType.startsWith("image/") || contentType === "application/pdf" || IMAGE_OR_PDF.test(lower);
    if (!ok) {
      return NextResponse.json(
        { error: "Please attach an image file (JPG, PNG, WEBP, HEIC, screenshot, etc.) or a PDF." },
        { status: 400 }
      );
    }

    const sb = serviceClient();
    if (!sb) {
      return NextResponse.json({ error: "Server is missing SUPABASE_SERVICE_ROLE_KEY." }, { status: 500 });
    }

    const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-120) || "ITR";
    const path = `${auth.studentId}/ITR/${Date.now()}_${safeName}`;

    const { data, error } = await sb.storage.from(BUCKET).createSignedUploadUrl(path);
    if (error || !data?.token) {
      return NextResponse.json(
        { error: `Could not prepare the upload: ${error?.message || "no token returned"}.` },
        { status: 502 }
      );
    }

    return NextResponse.json({ ok: true, path, token: data.token });
  } catch (err: unknown) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Upload could not be prepared." },
      { status: 500 }
    );
  }
}

/** PATCH — replace one or both ITR paths on one of this student's applications. */
export async function PATCH(req: Request) {
  try {
    const auth = await assertStudent(req);
    if (typeof auth === "string") {
      return NextResponse.json({ error: auth }, { status: 401 });
    }

    const body = (await req.json().catch(() => null)) as {
      application_id?: number;
      itr_file?: string;
      itr_file_p2?: string;
      form?: {
        father_name?: string;
        mother_name?: string;
        street_barangay?: string;
        zipcode?: string;
        disability?: string | null;
        indigenous_people_group?: string | null;
        contact_number?: string;
        email_address?: string;
        annual_income_family?: number;
        family_size?: number | null;
      };
    } | null;
    const applicationId = Number(body?.application_id);
    const hasPage1 = typeof body?.itr_file === "string";
    const hasPage2 = typeof body?.itr_file_p2 === "string";
    const form = body?.form;
    if (!Number.isInteger(applicationId) || applicationId <= 0 || (!hasPage1 && !hasPage2 && !form)) {
      return NextResponse.json({ error: "Choose application details to update." }, { status: 400 });
    }

    if (form) {
      const requiredText = [
        form.father_name,
        form.mother_name,
        form.street_barangay,
        form.zipcode,
        form.contact_number,
        form.email_address,
      ];
      if (requiredText.some((value) => typeof value !== "string" || !value.trim())) {
        return NextResponse.json({ error: "Complete all required application fields." }, { status: 400 });
      }
      if (/\d/.test(form.father_name!) || /\d/.test(form.mother_name!)) {
        return NextResponse.json({ error: "Parent names must not contain numbers." }, { status: 400 });
      }
      if (!/^[\d]{4}$/.test(form.zipcode!)) {
        return NextResponse.json({ error: "Zipcode must contain exactly 4 digits." }, { status: 400 });
      }
      if (!/^09\d{9}$/.test(form.contact_number!.replace(/\D/g, ""))) {
        return NextResponse.json({ error: "Enter a valid Philippine mobile number (09XXXXXXXXX)." }, { status: 400 });
      }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email_address!.trim())) {
        return NextResponse.json({ error: "Enter a valid email address." }, { status: 400 });
      }
      if (
        typeof form.annual_income_family !== "number" ||
        !Number.isFinite(form.annual_income_family) ||
        form.annual_income_family < 0
      ) {
        return NextResponse.json({ error: "Annual family income must be zero or more." }, { status: 400 });
      }
      if (
        form.family_size !== undefined &&
        form.family_size !== null &&
        (!Number.isInteger(form.family_size) || form.family_size < 1 || form.family_size > 20)
      ) {
        return NextResponse.json(
          { error: "Family Size must be a whole number from 1 to 20." },
          { status: 400 }
        );
      }
    }

    const ownFolder = `${auth.studentId}/ITR/`;
    for (const path of [body?.itr_file, body?.itr_file_p2]) {
      if (path !== undefined && (!path.startsWith(ownFolder) || path.includes(".."))) {
        return NextResponse.json({ error: "Invalid ITR upload path." }, { status: 403 });
      }
    }

    const sb = serviceClient();
    if (!sb) {
      return NextResponse.json({ error: "Server is missing SUPABASE_SERVICE_ROLE_KEY." }, { status: 500 });
    }

    const { data: application, error: applicationError } = await sb
      .from("scholarship_applications")
      .select("application_id, application_status, application_data")
      .eq("application_id", applicationId)
      .eq("student_id", auth.studentId)
      .maybeSingle();

    if (applicationError) {
      return NextResponse.json({ error: "Could not verify the application." }, { status: 500 });
    }
    if (!application) {
      return NextResponse.json({ error: "Application not found." }, { status: 404 });
    }
    if (application.application_status === "Approved") {
      return NextResponse.json({ error: "Approved applications can no longer be edited." }, { status: 409 });
    }

    const existingData =
      application.application_data &&
      typeof application.application_data === "object" &&
      !Array.isArray(application.application_data)
        ? application.application_data
        : {};
    const nextData = {
      ...existingData,
      ...(hasPage1 ? { itr_file: body!.itr_file } : {}),
      ...(hasPage2 ? { itr_file_p2: body!.itr_file_p2 } : {}),
    };

    const applicationDataUpdate = {
      ...nextData,
      ...(form ? { annual_income_family: form.annual_income_family } : {}),
      ...(form && form.family_size !== undefined ? { family_size: form.family_size } : {}),
    };
    const { data: updatedApplication, error: updateError } = await sb
      .from("scholarship_applications")
      .update({ application_data: applicationDataUpdate })
      .eq("application_id", applicationId)
      .eq("student_id", auth.studentId)
      .neq("application_status", "Approved")
      .select("application_id")
      .maybeSingle();

    if (updateError) {
      return NextResponse.json({ error: `Could not save application update: ${updateError.message}` }, { status: 500 });
    }
    if (!updatedApplication) {
      return NextResponse.json({ error: "This application can no longer be edited." }, { status: 409 });
    }
    Object.assign(nextData, applicationDataUpdate);

    if (!form && hasPage1) {
      const { error: legacyUpdateError } = await sb
        .from("ched_form_input")
        .update({ income_tax_return: body!.itr_file! })
        .eq("application_id", applicationId);
      if (legacyUpdateError) {
        await sb
          .from("scholarship_applications")
          .update({ application_data: existingData })
          .eq("application_id", applicationId)
          .eq("student_id", auth.studentId);
        return NextResponse.json({ error: `Could not save legacy application data: ${legacyUpdateError.message}` }, { status: 500 });
      }
    }

    if (form) {
      const formUpdate = {
        father_name: form.father_name!.trim(),
        mother_name: form.mother_name!.trim(),
        street_barangay: form.street_barangay!.trim(),
        zipcode: form.zipcode!,
        disability: form.disability?.trim() || null,
        indigenous_people_group: form.indigenous_people_group?.trim() || null,
        contact_number: form.contact_number!.replace(/\D/g, ""),
        email_address: form.email_address!.trim(),
        annual_income_family: form.annual_income_family!,
        ...(hasPage1 ? { income_tax_return: body!.itr_file! } : {}),
      };
      const { data: updatedForm, error: formError } = await sb
        .from("ched_form_input")
        .update(formUpdate)
        .eq("application_id", applicationId)
        .select("application_id")
        .maybeSingle();

      if (formError) {
        await sb
          .from("scholarship_applications")
          .update({ application_data: existingData })
          .eq("application_id", applicationId)
          .eq("student_id", auth.studentId);
        return NextResponse.json({ error: `Could not save application details: ${formError.message}` }, { status: 500 });
      }
      if (!updatedForm) {
        await sb
          .from("scholarship_applications")
          .update({ application_data: existingData })
          .eq("application_id", applicationId)
          .eq("student_id", auth.studentId);
        return NextResponse.json({ error: "The submitted application form could not be found." }, { status: 404 });
      }
    }

    const replacedPaths = Array.from(new Set([
      hasPage1 ? existingData.itr_file : null,
      hasPage2 ? existingData.itr_file_p2 : null,
    ].filter((path): path is string =>
      typeof path === "string" &&
      path.startsWith(ownFolder) &&
      path !== (hasPage1 ? body!.itr_file : undefined) &&
      path !== (hasPage2 ? body!.itr_file_p2 : undefined)
    )));
    const cleanupWarnings: string[] = [];

    if (replacedPaths.length) {
      const { data: studentApplications, error: referencesError } = await sb
        .from("scholarship_applications")
        .select("application_id, application_data")
        .eq("student_id", auth.studentId);

      if (referencesError || !studentApplications) {
        cleanupWarnings.push("Could not verify whether old ITR files are still used.");
      } else {
        const applicationIds = studentApplications.map((row) => row.application_id);
        const { data: legacyForms, error: legacyError } = applicationIds.length
          ? await sb
              .from("ched_form_input")
              .select("income_tax_return")
              .in("application_id", applicationIds)
          : { data: [], error: null };

        if (legacyError) {
          cleanupWarnings.push("Could not verify legacy ITR references.");
        } else {
          const referencedPaths = new Set<string>();
          for (const row of studentApplications) {
            const data = row.application_data;
            if (!data || typeof data !== "object" || Array.isArray(data)) continue;
            if (typeof data.itr_file === "string") referencedPaths.add(data.itr_file);
            if (typeof data.itr_file_p2 === "string") referencedPaths.add(data.itr_file_p2);
          }
          for (const form of legacyForms || []) {
            if (typeof form.income_tax_return === "string") {
              referencedPaths.add(form.income_tax_return);
            }
          }

          const safeToRemove = replacedPaths.filter((path) => !referencedPaths.has(path));
          const stillInUse = replacedPaths.length - safeToRemove.length;
          if (stillInUse > 0) {
            cleanupWarnings.push(
              `${stillInUse} old ITR file(s) were kept because another application still uses them.`
            );
          }
          if (safeToRemove.length) {
            const { error: removeError } = await sb.storage.from(BUCKET).remove(safeToRemove);
            if (removeError) {
              cleanupWarnings.push(`Could not remove ${safeToRemove.length} old ITR file(s): ${removeError.message}`);
            }
          }
        }
      }
    }

    return NextResponse.json({
      ok: true,
      application_data: nextData,
      cleanup_warning: cleanupWarnings.length ? cleanupWarnings.join(" ") : null,
    });
  } catch (err: unknown) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "The ITR update could not be saved." },
      { status: 500 }
    );
  }
}

/** DELETE — best-effort cleanup when the application insert fails. */
export async function DELETE(req: Request) {
  try {
    const auth = await assertStudent(req);
    if (typeof auth === "string") {
      return NextResponse.json({ error: auth }, { status: 401 });
    }

    const body = (await req.json().catch(() => null)) as {
      path?: string;
      application_id?: number;
      page?: "itr_file" | "itr_file_p2";
    } | null;
    const applicationId = Number(body?.application_id);
    if (Number.isInteger(applicationId) && applicationId > 0) {
      const page = body?.page;
      if (page !== "itr_file" && page !== "itr_file_p2") {
        return NextResponse.json({ error: "Select a valid ITR page to remove." }, { status: 400 });
      }

      const sb = serviceClient();
      if (!sb) {
        return NextResponse.json({ error: "Server is missing SUPABASE_SERVICE_ROLE_KEY." }, { status: 500 });
      }
      const { data: application, error: appError } = await sb
        .from("scholarship_applications")
        .select("application_id, application_status, application_data")
        .eq("application_id", applicationId)
        .eq("student_id", auth.studentId)
        .maybeSingle();

      if (appError) {
        return NextResponse.json({ error: "Could not verify the application." }, { status: 500 });
      }
      if (!application) {
        return NextResponse.json({ error: "Application not found." }, { status: 404 });
      }
      if (application.application_status === "Approved") {
        return NextResponse.json({ error: "Approved applications can no longer be edited." }, { status: 409 });
      }

      const existingData =
        application.application_data &&
        typeof application.application_data === "object" &&
        !Array.isArray(application.application_data)
          ? application.application_data
          : {};
      const oldPath = typeof existingData[page] === "string" ? existingData[page] as string : null;
      if (!oldPath) {
        return NextResponse.json({ error: "This application has no file attached to that ITR page." }, { status: 404 });
      }

      if (!oldPath.startsWith(`${auth.studentId}/ITR/`) || oldPath.includes("..")) {
        return NextResponse.json({ error: "Invalid ITR upload path." }, { status: 403 });
      }

      const { data: studentApplications, error: refsError } = await sb
        .from("scholarship_applications")
        .select("application_id, application_data")
        .eq("student_id", auth.studentId);
      if (refsError || !studentApplications) {
        return NextResponse.json({ error: "Could not find every application that uses this ITR file." }, { status: 500 });
      }

      const affectedApplications = studentApplications.flatMap((row) => {
        const data =
          row.application_data &&
          typeof row.application_data === "object" &&
          !Array.isArray(row.application_data)
            ? row.application_data
            : {};
        if (data.itr_file !== oldPath && data.itr_file_p2 !== oldPath) return [];
        const nextData = { ...data };
        if (nextData.itr_file === oldPath) nextData.itr_file = null;
        if (nextData.itr_file_p2 === oldPath) nextData.itr_file_p2 = null;
        return [{ applicationId: row.application_id, previousData: data, nextData }];
      });

      const appIds = studentApplications.map((row) => row.application_id);
      const { data: matchingForms, error: formsError } = appIds.length
        ? await sb
            .from("ched_form_input")
            .select("application_id")
            .in("application_id", appIds)
            .eq("income_tax_return", oldPath)
        : { data: [], error: null };
      if (formsError) {
        return NextResponse.json({ error: "Could not verify legacy ITR references." }, { status: 500 });
      }

      const updatedApplications: typeof affectedApplications = [];
      for (const affected of affectedApplications) {
        const { data: updated, error: updateError } = await sb
          .from("scholarship_applications")
          .update({ application_data: affected.nextData })
          .eq("application_id", affected.applicationId)
          .eq("student_id", auth.studentId)
          .select("application_id")
          .maybeSingle();
        if (updateError || !updated) {
          const rollbackResults = await Promise.all(updatedApplications.map((item) =>
            sb
              .from("scholarship_applications")
              .update({ application_data: item.previousData })
              .eq("application_id", item.applicationId)
              .eq("student_id", auth.studentId)
          ));
          const rollbackFailed = rollbackResults.some((result) => result.error);
          return NextResponse.json({
            error: rollbackFailed
              ? "Could not remove the ITR file from every application, and some application references could not be restored. Please contact support."
              : `Could not remove the ITR page from every application${updateError ? `: ${updateError.message}` : "."}`,
          }, { status: 500 });
        }
        updatedApplications.push(affected);
      }

      const formIds = (matchingForms || []).map((form) => form.application_id);
      if (formIds.length) {
        const { error: legacyUpdateError } = await sb
          .from("ched_form_input")
          .update({ income_tax_return: null })
          .in("application_id", formIds)
          .eq("income_tax_return", oldPath);
        if (legacyUpdateError) {
          const rollbackResults = await Promise.all(updatedApplications.map((item) =>
            sb
              .from("scholarship_applications")
              .update({ application_data: item.previousData })
              .eq("application_id", item.applicationId)
              .eq("student_id", auth.studentId)
          ));
          const rollbackFailed = rollbackResults.some((result) => result.error);
          return NextResponse.json({
            error: rollbackFailed
              ? "Could not clear the legacy ITR reference, and some application references could not be restored. Please contact support."
              : `Could not remove the legacy ITR reference: ${legacyUpdateError.message}`,
          }, { status: 500 });
        }
      }

      const { error: removeError } = await sb.storage.from(BUCKET).remove([oldPath]);
      if (removeError) {
        const rollbackResults = await Promise.all(updatedApplications.map((item) =>
          sb
            .from("scholarship_applications")
            .update({ application_data: item.previousData })
            .eq("application_id", item.applicationId)
            .eq("student_id", auth.studentId)
        ));
        const { error: legacyRollbackError } = formIds.length
          ? await sb
              .from("ched_form_input")
              .update({ income_tax_return: oldPath })
              .in("application_id", formIds)
              .is("income_tax_return", null)
          : { error: null };
        const rollbackFailed = rollbackResults.some((result) => result.error) || Boolean(legacyRollbackError);
        return NextResponse.json({
          error: rollbackFailed
            ? "The storage file could not be deleted and some application references could not be restored. Please contact support."
            : `The storage file could not be deleted: ${removeError.message}. Your application references were restored; please try again.`,
        }, { status: 500 });
      }

      const currentApplication = affectedApplications.find((item) => item.applicationId === applicationId);
      return NextResponse.json({
        ok: true,
        application_data: currentApplication?.nextData ?? { ...existingData, [page]: null },
        removed_path: oldPath,
        removed_application_ids: [...new Set([
          ...affectedApplications.map((item) => item.applicationId),
          ...formIds,
        ])],
        cleanup_warning: null,
      });
    }

    const path = String(body?.path || "");

    // Only ever delete inside this student's own folder.
    if (!path || !path.startsWith(`${auth.studentId}/ITR/`)) {
      return NextResponse.json({ error: "Invalid path." }, { status: 403 });
    }

    const sb = serviceClient();
    if (!sb) {
      return NextResponse.json({ error: "Server is missing SUPABASE_SERVICE_ROLE_KEY." }, { status: 500 });
    }

    const { error: removeError } = await sb.storage.from(BUCKET).remove([path]);
    if (removeError) {
      return NextResponse.json({ error: `Could not delete the unused ITR file: ${removeError.message}` }, { status: 500 });
    }
    return NextResponse.json({ ok: true });
  } catch (err: unknown) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Cleanup failed." },
      { status: 500 }
    );
  }
}
