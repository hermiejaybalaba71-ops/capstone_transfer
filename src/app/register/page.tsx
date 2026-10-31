"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import toast from "react-hot-toast";
import { getSupabase } from "@/lib/supabase/browser";
import { queryRegistrar } from "@/lib/supabase/registrar";
import { PROGRAMS, YEAR_LEVELS } from "@/lib/constants";

interface Form {
  studentNumber: string;
  givenName: string;
  middleName: string;
  lastName: string;
  extName: string;
  sex: string;
  birthdate: string;
  programName: string;
  yearLevel: string;
  applicantType: string;
  username: string;
  email: string;
  password: string;
  confirmPassword: string;
}

function SectionTitle({ number, title, description }: { number: string; title: string; description?: string }) {
  return (
    <div className="flex items-start gap-3">
      <div className="flex h-8 w-8 flex-none items-center justify-center rounded-full bg-[#7B1113] text-xs font-bold text-white">{number}</div>
      <div className="min-w-0">
        <h2 className="text-base font-bold text-[#241012]">{title}</h2>
        {description && <p className="mt-0.5 text-xs leading-relaxed text-[#6B5458]">{description}</p>}
      </div>
    </div>
  );
}

function Label({ children, required }: { children: React.ReactNode; required?: boolean }) {
  return <label className="mb-1.5 block text-xs font-bold text-[#241012]">{children}{required && <span className="ml-0.5 text-[#7B1113]">*</span>}</label>;
}

function Input({ label, name, value, onChange, placeholder, type = "text", required = false, disabled = false, max }: { label: string; name: string; value: string; onChange: (e: React.ChangeEvent<HTMLInputElement>) => void; placeholder: string; type?: string; required?: boolean; disabled?: boolean; max?: string }) {
  return (
    <div className="min-w-0">
      <Label required={required}>{label}{!required && <span className="ml-1 rounded-full bg-[#F3EEEB] px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-[#8B7376]">Optional</span>}</Label>
      <input type={type} name={name} value={value} onChange={onChange} placeholder={placeholder} required={required} disabled={disabled} max={max} className="box-border min-w-0 w-full rounded-xl border border-[#241012]/10 bg-white px-3.5 py-2.5 text-sm text-[#241012] outline-none transition placeholder:text-xs placeholder:text-[#8B7376] focus:border-[#7B1113] focus:ring-4 focus:ring-[#7B1113]/10 disabled:cursor-not-allowed disabled:bg-[#F3EEEB] disabled:text-[#5F4B4E] disabled:opacity-100" />
    </div>
  );
}

function SelectField({ label, name, value, onChange, placeholder, options, required = false, disabled = false }: { label: string; name: string; value: string; onChange: (e: React.ChangeEvent<HTMLSelectElement>) => void; placeholder: string; options: readonly string[] | string[]; required?: boolean; disabled?: boolean }) {
  return (
    <div className="min-w-0">
      <Label required={required}>{label}</Label>
      <select name={name} value={value} onChange={onChange} required={required} disabled={disabled} className="w-full rounded-xl border border-[#241012]/10 bg-white px-3.5 py-2.5 text-sm text-[#241012] outline-none transition focus:border-[#7B1113] focus:ring-4 focus:ring-[#7B1113]/10 disabled:cursor-not-allowed disabled:bg-[#F3EEEB] disabled:text-[#5F4B4E] disabled:opacity-100">
        <option value="">{placeholder}</option>
        {options.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    </div>
  );
}

function PasswordInput({ label, name, value, onChange, placeholder, show, setShow, disabled }: { label: string; name: string; value: string; onChange: (e: React.ChangeEvent<HTMLInputElement>) => void; placeholder: string; show: boolean; setShow: (v: boolean) => void; disabled: boolean }) {
  return (
    <div className="min-w-0">
      <Label required>{label}</Label>
      <div className="relative">
        <input type={show ? "text" : "password"} name={name} value={value} onChange={onChange} placeholder={placeholder} required disabled={disabled} className="box-border min-w-0 w-full rounded-xl border border-[#241012]/10 bg-white px-3.5 py-2.5 pr-14 text-sm text-[#241012] outline-none transition placeholder:text-xs placeholder:text-[#8B7376] focus:border-[#7B1113] focus:ring-4 focus:ring-[#7B1113]/10 disabled:cursor-not-allowed disabled:bg-[#F3EEEB] disabled:text-[#5F4B4E] disabled:opacity-100" />
        <button type="button" onClick={() => setShow(!show)} disabled={disabled} className="absolute right-3 top-1/2 -translate-y-1/2 text-xs font-semibold text-[#7B1113] hover:underline disabled:opacity-50">{show ? "Hide" : "Show"}</button>
      </div>
    </div>
  );
}

function ApplicantChip({ type, description, selected, disabled, onClick }: { type: string; description: string; selected: boolean; disabled: boolean; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} className={`flex items-center justify-between gap-3 rounded-xl border-2 px-4 py-3.5 text-left transition ${selected ? "border-[#7B1113] bg-[#FAF7F5] shadow-sm" : "border-[#241012]/10 bg-white hover:border-[#7B1113]/30"} ${disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer"}`}>
      <div>
        <p className="text-sm font-bold text-[#241012]">{type}</p>
        <p className="mt-0.5 text-xs text-[#6B5458]">{description}</p>
      </div>
      <div className={`flex h-5 w-5 flex-none items-center justify-center rounded-full border-2 ${selected ? "border-[#7B1113] bg-[#7B1113]" : "border-[#6B5458]/30"}`}>
        {selected && <span className="h-2 w-2 rounded-full bg-white" />}
      </div>
    </button>
  );
}

function Spinner() {
  return <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />;
}

export default function RegisterPage() {
  const router = useRouter();
  const [form, setForm] = useState<Form>({ studentNumber: "", givenName: "", middleName: "", lastName: "", extName: "", sex: "", birthdate: "", programName: "", yearLevel: "", applicantType: "", username: "", email: "", password: "", confirmPassword: "" });
  const [registering, setRegistering] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [agreeTerms, setAgreeTerms] = useState(false);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value } = e.target;
    const cleanValue = name === "email" ? value.replace(/\s/g, "") : value;
    setForm((prev) => ({ ...prev, [name]: cleanValue }));
    setError("");
  };

  const validateForm = () => {
    if (!form.applicantType) { setError("Please select your applicant type."); return false; }
    if (form.applicantType === "Freshman" && form.yearLevel !== "1st Year") { setError("Freshman applicants are automatically assigned to 1st Year."); return false; }
    if (!form.studentNumber.trim()) { setError("Please enter your student number."); return false; }
    if (!form.givenName.trim()) { setError("Please enter your given name."); return false; }
    if (!form.lastName.trim()) { setError("Please enter your last name."); return false; }
    if (!form.sex) { setError("Please select your sex."); return false; }
    if (!form.birthdate) { setError("Please enter your birthdate."); return false; }
    if (!form.programName) { setError("Please select your program."); return false; }
    if (!form.yearLevel) { setError("Please select your year level."); return false; }
    if (!form.username.trim()) { setError("Please enter a username."); return false; }
    if (!form.email.trim()) { setError("Please enter your email address."); return false; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) { setError("Please enter a valid email address."); return false; }
    if (!form.password) { setError("Please enter a password."); return false; }
    if (form.password.length < 8) { setError("Password must contain at least 8 characters."); return false; }
    if (form.password !== form.confirmPassword) { setError("Passwords do not match."); return false; }
    if (!agreeTerms) { setError("Please read and agree to the Terms and Conditions of the system before creating your account."); return false; }
    return true;
  };

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setSuccess("");
    if (!validateForm()) return;

    const sb = getSupabase();
    const { data: availability, error: availabilityError } = await sb.rpc("check_registration_availability", { p_email: form.email.trim(), p_username: form.username.trim(), p_student_number: form.studentNumber.trim() || null });

    if (!availabilityError && availability) {
      if (availability.email_taken) { setError("An account with this email address already exists."); return; }
      if (availability.username_taken) { setError("This username is already taken."); return; }
      if (availability.student_number_taken) { setError("This student number is already registered."); return; }
    }

    setRegistering(true);
    try {
      const { data: authData, error: authError } = await sb.auth.signUp({ email: form.email.trim(), password: form.password, options: { data: { username: form.username.trim(), role: "Student", student_number: form.studentNumber.trim() || null, given_name: form.givenName.trim() || null, middle_name: form.middleName.trim() || null, last_name: form.lastName.trim() || null, ext_name: form.extName.trim() || null, sex: form.sex || null, birthdate: form.birthdate || null, program_name: form.programName.trim() || null, year_level: form.yearLevel.trim() || null, applicant_type: form.applicantType } } });

      if (authError) throw authError;
      if (!authData.user) throw new Error("Unable to create the authentication account.");

      let isVerified = false;
      if (form.studentNumber.trim()) {
        const reg = await queryRegistrar<{ student_number: string; registration_status?: string }>((rsb) =>
          rsb
            .from("registrar_students")
            .select("student_number, registration_status")
            .eq("student_number", form.studentNumber.trim())
            .maybeSingle()
        );
        isVerified = !!reg.data;
      }

      const sb2 = getSupabase();

      // The handle_new_student_registration trigger creates the users row asynchronously
      // after signUp. Poll briefly so we attach the correct user_id instead of racing it.
      let assignedUserId: number | null = null;
      let user_id_payload: Record<string, unknown> | null = null;
      for (let attempt = 0; attempt < 10; attempt++) {
        const { data: found } = await sb2
          .from("users")
          .select("user_id")
          .eq("auth_user_id", authData.user.id)
          .maybeSingle();
        if (found) {
          assignedUserId = found.user_id;
          break;
        }
        await new Promise((r) => setTimeout(r, 500));
      }

      if (!assignedUserId) {
        // Trigger never created the row (function disabled, error, etc.).
        // Fall back to inserting explicitly so the auth user is never orphaned.
        const { data: extra } = await sb2.auth.getUser();
        const confirmedEmail = extra?.user?.email || form.email.trim();
        const { error: userInsErr } = await sb2.from("users").insert({
          auth_user_id: authData.user.id,
          email: confirmedEmail,
          username: form.username.trim(),
          first_name: form.givenName.trim(),
          middle_name: form.middleName.trim(),
          last_name: form.lastName.trim(),
          ext_name: form.extName.trim(),
          sex: form.sex,
          birthdate: form.birthdate || null,
          program_name: form.programName.trim(),
          year_level: form.yearLevel.trim(),
          role: "Student",
        });
        if (userInsErr) throw userInsErr;
        const { data: reFound, error: reErr } = await sb2
          .from("users")
          .select("user_id")
          .eq("auth_user_id", authData.user.id)
          .maybeSingle();
        if (reErr || !reFound) throw new Error("Account created but we could not link your records. Please contact support.");
        assignedUserId = reFound.user_id;
        user_id_payload = { user_id: assignedUserId, given_name: form.givenName.trim(), last_name: form.lastName.trim(), student_number: form.studentNumber.trim(), program_name: form.programName.trim(), year_level: form.yearLevel.trim(), applicant_type: form.applicantType, sex: form.sex, birthdate: form.birthdate || null, registration_status: isVerified ? "Verified" : "Unverified" };
      }

      // Ensure a student_account row exists (trigger normally creates it too).
      if (user_id_payload) {
        await sb2.from("student_accounts").insert(user_id_payload).select("student_id").maybeSingle();
      } else {
        const { data: foundStudent } = await sb2
          .from("student_accounts")
          .select("student_id")
          .eq("user_id", assignedUserId)
          .maybeSingle();
        if (!foundStudent) {
          const { error: saErr } = await sb2.from("student_accounts").insert({
            user_id: assignedUserId,
            given_name: form.givenName.trim(),
            last_name: form.lastName.trim(),
            student_number: form.studentNumber.trim(),
            program_name: form.programName.trim(),
            year_level: form.yearLevel.trim(),
            applicant_type: form.applicantType,
            sex: form.sex,
            birthdate: form.birthdate || null,
            registration_status: isVerified ? "Verified" : "Unverified",
          });
          if (saErr) throw saErr;
        } else {
          await sb2
            .from("student_accounts")
            .update({ registration_status: isVerified ? "Verified" : "Unverified" })
            .eq("student_id", foundStudent.student_id);
        }
      }

      // signUp may auto-create a session (email confirmation disabled).
      // Sign out so middleware does not bounce /login → / after redirect.
      try { await sb2.auth.signOut(); } catch { /* ignore */ }

      if (isVerified) {
        setSuccess("Your account has been created and verified against the Registrar — student number matched. You can now log in and apply for scholarships.");
        toast.success("Account created and verified against the Registrar. Redirecting to login...");
      } else {
        setSuccess("Your account has been created. Your student number was not found in the Registrar database — you can still log in, but you must contact the admin to be verified before applying for scholarships.");
        toast.success("Account created. Please contact the admin to be verified.");
      }
      setTimeout(() => router.push("/login"), 2500);
    } catch (err: unknown) {
      const e = err as { message?: string; code?: string; status?: number; details?: string };
      const msg = String(e?.message || "").toLowerCase();
      const code = String(e?.code || "");
      const details = String(e?.details || "").toLowerCase();
      const status = Number(e?.status) || 0;

      if (code === "23505" || msg.includes("unique constraint") || msg.includes("duplicate key")) {
        const constraint = `${msg} ${details}`;
        if (constraint.includes("student_number")) { setError("A student with this number is already registered."); return; }
        if (constraint.includes("username")) { setError("Username already taken. Please choose another."); return; }
        if (constraint.includes("email")) { setError("An account with this email already exists."); return; }
        setError("An account with this information already exists. Please check your details."); return;
      }

      if (msg.includes("student_number_key")) { setError("A student with this number is already registered."); return; }
      if (msg.includes("users_username_key")) { setError("Username already taken. Please choose another."); return; }
      if (msg.includes("already registered") || msg.includes("user already exists")) { setError("An account with this email already exists."); return; }
      if (msg.includes("database error saving new user")) { setError("We could not save your account. Please double-check your details."); return; }

      if (status === 429 || msg.includes("rate limit") || msg.includes("too many")) { setError("Too many registration attempts. Please wait a moment and try again."); return; }

      setError((err as Error).message || "Registration failed. Please check your information and try again.");
    } finally {
      setRegistering(false);
    }
  };

  return (
    <div className="flex min-h-screen bg-[#FAF7F5] font-sans text-[#241012]">
      {/* Back to homepage */}
      <Link href="/" title="Back to homepage" aria-label="Back to homepage" className="fixed right-4 top-4 z-[60] inline-flex items-center gap-2 rounded-full border border-[#241012]/10 bg-white py-2 pl-2.5 pr-4 text-xs font-semibold text-[#7B1113] shadow-lg transition hover:bg-[#FAF7F5]">
        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-[#7B1113]/10">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="h-3.5 w-3.5"><path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12l8.954-8.955c.44-.439 1.152-.439 1.591 0L21.75 12M4.5 9.75v10.125c0 .621.504 1.125 1.125 1.125H9.75v-4.875c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125V21h4.125c.621 0 1.125-.504 1.125-1.125V9.75" /></svg>
        </span>
        Home
      </Link>

      <aside className="relative hidden w-[40%] flex-col justify-between overflow-hidden bg-gradient-to-br from-[#7B1113] via-[#5A0C0E] to-[#3E0009] p-12 text-white xl:flex 2xl:p-16">
        <div className="pointer-events-none absolute -right-24 -top-24 h-80 w-80 rounded-full bg-white/[0.06]" />
        <div className="pointer-events-none absolute -bottom-36 -left-20 h-96 w-96 rounded-full bg-black/20" />
        <Link href="/" className="relative flex items-center gap-3">
          <img src="/logo.jpg" alt="St. Peter's College logo" className="h-11 w-11 flex-none rounded-xl bg-white object-contain shadow" />
          <span className="leading-tight">
            <span className="block text-base font-bold">St. Peter&rsquo;s College</span>
            <span className="block text-xs text-white/70">Iligan City</span>
          </span>
        </Link>
        <div className="relative">
          <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-white/60">Student Registration</p>
          <h1 className="mt-5 text-4xl font-bold leading-[1.15] 2xl:text-[2.6rem]">
            Create your student account and apply in minutes.
          </h1>
          <ul className="mt-9 space-y-4 text-sm text-white/85">
            {[
              "Pick your applicant type, then fill in one short form",
              "Your student number is checked against the Registrar",
              "Log in to upload documents and apply for scholarships",
            ].map((f) => (
              <li key={f} className="flex items-start gap-3">
                <span className="mt-0.5 flex h-6 w-6 flex-none items-center justify-center rounded-full bg-white/15 text-[11px] font-bold">&#10003;</span>
                <span className="leading-relaxed">{f}</span>
              </li>
            ))}
          </ul>
        </div>
        <p className="relative text-xs leading-relaxed text-white/55">
          &copy; {new Date().getFullYear()} St. Peter&rsquo;s College &middot; Scholarship &amp; Financial Aid Office
        </p>
      </aside>

      <main className="flex flex-1 items-start justify-center px-4 py-8 sm:px-8 lg:items-center lg:py-10">
        <form onSubmit={handleRegister} className="w-full max-w-2xl">
          <div className="mb-6 flex flex-col items-center lg:hidden">
            <Link href="/" className="flex flex-col items-center">
              <img src="/logo.jpg" alt="St. Peter's College logo" className="h-12 w-12 flex-none rounded-xl bg-white object-contain shadow" />
              <span className="mt-3 block text-lg font-bold text-[#241012]">St. Peter&rsquo;s College</span>
              <span className="mt-0.5 block text-xs text-[#6B5458]">Scholarship System</span>
            </Link>
            <Link href="/login" className="mt-4 rounded-lg border border-[#7B1113]/25 px-4 py-2 text-xs font-semibold text-[#7B1113] transition hover:bg-[#7B1113]/5">Log in</Link>
          </div>

          <div className="rounded-2xl border border-[#241012]/[0.06] bg-white p-6 shadow-[0_18px_50px_-20px_rgba(36,16,18,0.18)] sm:p-8">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-[0.25em] text-[#7B1113]">Student Registration</p>
                <h1 className="mt-1.5 text-2xl font-bold text-[#241012]">Create your account</h1>
                <p className="mt-1 text-sm leading-relaxed text-[#6B5458]">
                  Fill in the form below — fields marked <span className="font-bold text-[#7B1113]">*</span> are required.
                </p>
              </div>
              <Link href="/login" className="hidden shrink-0 rounded-lg border border-[#7B1113]/25 px-3 py-2 text-xs font-semibold text-[#7B1113] transition hover:bg-[#7B1113]/5 sm:block">Already have an account?</Link>
            </div>

            {error && <div className="mt-5 flex gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"><span className="font-bold">!</span><p>{error}</p></div>}
            {success && <div className="mt-5 flex gap-3 rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700"><span className="font-bold">&#10003;</span><p>{success}</p></div>}

            <section className="mt-7">
              <SectionTitle number="01" title="Who are you?" description="This decides which records are used to rank your application." />
              <div className="mt-3.5 grid gap-3 sm:grid-cols-2">
                <ApplicantChip type="Freshman" description="Using Senior High School records" selected={form.applicantType === "Freshman"} disabled={registering} onClick={() => setForm((prev) => ({ ...prev, applicantType: "Freshman", yearLevel: "1st Year" }))} />
                <ApplicantChip type="Alumni" description="Using college academic records" selected={form.applicantType === "Alumni"} disabled={registering} onClick={() => setForm((prev) => ({ ...prev, applicantType: "Alumni", yearLevel: prev.yearLevel === "1st Year" ? "" : prev.yearLevel }))} />
              </div>
              {form.applicantType === "Freshman" && (
                <p className="mt-2 text-[11px] text-[#7B1113]">Tip: Freshman applicants are automatically set to 1st Year.</p>
              )}
            </section>

            <div className="my-7 h-px bg-[#241012]/[0.06]" />

            <section>
              <SectionTitle number="02" title="Your details" description="Use the exact spelling in your student record." />
              <div className="mt-3.5 grid gap-x-4 gap-y-3.5 md:grid-cols-3">
                <Input label="Student Number" name="studentNumber" value={form.studentNumber} onChange={handleChange} placeholder="2023-00010" required disabled={registering} />
                <SelectField label="Sex" name="sex" value={form.sex} onChange={handleChange} placeholder="Select sex" options={["Male", "Female"]} required disabled={registering} />
                <Input label="Birthdate" name="birthdate" type="date" value={form.birthdate} onChange={handleChange} placeholder="" max={new Date().toISOString().split("T")[0]} required disabled={registering} />
                <Input label="Given Name" name="givenName" value={form.givenName} onChange={handleChange} placeholder="Juan" required disabled={registering} />
                <Input label="Middle Name" name="middleName" value={form.middleName} onChange={handleChange} placeholder="Santos (optional)" disabled={registering} />
                <Input label="Last Name" name="lastName" value={form.lastName} onChange={handleChange} placeholder="Dela Cruz" required disabled={registering} />
                <Input label="Extension Name" name="extName" value={form.extName} onChange={handleChange} placeholder="Jr., Sr., III" disabled={registering} />
                <SelectField label="Program" name="programName" value={form.programName} onChange={handleChange} placeholder="Select program" options={PROGRAMS} required disabled={registering} />
                <SelectField label="Year Level" name="yearLevel" value={form.yearLevel} onChange={handleChange} placeholder="Select year level" options={YEAR_LEVELS} required disabled={registering || form.applicantType === "Freshman"} />
              </div>
            </section>

            <div className="my-7 h-px bg-[#241012]/[0.06]" />

            <section>
              <SectionTitle number="03" title="Login details" description="You will use these to sign in to your account." />
              <div className="mt-3.5 grid gap-x-4 gap-y-3.5 md:grid-cols-3">
                <Input label="Username" name="username" value={form.username} onChange={handleChange} placeholder="juandelacruz" required disabled={registering} />
                <Input label="Email Address" name="email" type="email" value={form.email} onChange={handleChange} placeholder="juan.delacruz@gmail.com" required disabled={registering} />
                <div className="hidden md:block" />
                <PasswordInput label="Password" name="password" value={form.password} onChange={handleChange} placeholder="At least 8 characters" show={showPassword} setShow={setShowPassword} disabled={registering} />
                <PasswordInput label="Confirm Password" name="confirmPassword" value={form.confirmPassword} onChange={handleChange} placeholder="Repeat password" show={showConfirmPassword} setShow={setShowConfirmPassword} disabled={registering} />
              </div>
              <p className="mt-2 text-[11px] text-[#8B7376]">Tip: use at least 8 characters and keep your password private.</p>
            </section>

            <div className="mt-8 border-t border-[#241012]/[0.06] pt-6">
              <label className="flex cursor-pointer items-start gap-3">
                <input
                  type="checkbox"
                  checked={agreeTerms}
                  disabled={registering}
                  onChange={(e) => { setAgreeTerms(e.target.checked); setError(""); }}
                  className="mt-0.5 h-4 w-4 accent-[#7B1113]"
                />
                <span className="text-xs leading-relaxed text-[#6B5458]">
                  I have read and agree to the{" "}
                  <Link
                    href="/terms"
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={(e) => e.stopPropagation()}
                    className="font-bold text-[#7B1113] underline underline-offset-2 hover:brightness-110"
                  >
                    Terms and Conditions
                  </Link>{" "}
                  of the ISEWM Scholarship System &mdash; including the OCR verification of my uploaded ITR, the
                  automated financial-need ranking, and the privacy of the data I submit.
                </span>
              </label>
              {!agreeTerms && (
                <p className="ml-7 mt-1 text-[11px] font-semibold text-[#7B1113]">
                  Required: you must agree to the Terms and Conditions to create your account.
                </p>
              )}
              <label className="mt-3 flex cursor-pointer items-start gap-3">
                <input type="checkbox" required disabled={registering} className="mt-0.5 h-4 w-4 accent-[#7B1113]" />
                <span className="text-xs leading-relaxed text-[#6B5458]">I confirm that the information I provided is accurate and matches my registered student record.</span>
              </label>
              <div className="mt-5 flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-xs leading-relaxed text-[#8B7376]">After registering, you can log in to continue with your documents, academic records, and scholarship application.</p>
                <button type="submit" disabled={registering} className="shrink-0 rounded-xl bg-gradient-to-r from-[#7B1113] to-[#540111] px-8 py-3 text-sm font-bold text-white shadow-md transition hover:brightness-110 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-50">
                  {registering ? <span className="flex items-center justify-center gap-2"><Spinner />Creating Account...</span> : "Create Student Account"}
                </button>
              </div>
            </div>
          </div>
        </form>
      </main>
    </div>
  );
}