"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import toast from "react-hot-toast";
import { getSupabase } from "@/lib/supabase/browser";

function Field({ label, type, value, onChange, placeholder, showToggle, onToggle, icon }: { label: string; type: string; value: string; onChange: (e: React.ChangeEvent<HTMLInputElement>) => void; placeholder: string; showToggle?: boolean; onToggle?: () => void; icon?: string }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-semibold text-[#241012]">{label}</span>
      <div className="relative">
        {icon && (
          <span className="pointer-events-none absolute left-3.5 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center text-[#8B7376]">
            {icon === "mail" ? (
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.6} stroke="currentColor" className="h-[18px] w-[18px]"><path strokeLinecap="round" strokeLinejoin="round" d="M21.75 6.75v10.5a2.25 2.25 0 0 1-2.25 2.25h-15a2.25 2.25 0 0 1-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0 0 19.5 4.5h-15a2.25 2.25 0 0 0-2.25 2.25m19.5 0v.243a2.25 2.25 0 0 1-1.07 1.916l-7.5 4.615a2.25 2.25 0 0 1-2.36 0L3.32 8.91a2.25 2.25 0 0 1-1.07-1.916V6.75" /></svg>
            ) : (
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.6} stroke="currentColor" className="h-[18px] w-[18px]"><path strokeLinecap="round" strokeLinejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 1 0-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 0 0 2.25-2.25v-6.75a2.25 2.25 0 0 0-2.25-2.25H6.75a2.25 2.25 0 0 0-2.25 2.25v6.75a2.25 2.25 0 0 0 2.25 2.25Z" /></svg>
            )}
          </span>
        )}
        <input type={type} value={value} onChange={onChange} placeholder={placeholder} required className={`box-border w-full rounded-xl border border-[#241012]/10 bg-white px-4 py-3 text-sm text-[#241012] outline-none transition placeholder:text-[#8B7376] focus:border-[#7B1113] focus:ring-4 focus:ring-[#7B1113]/10 ${icon ? "pl-11" : ""} ${showToggle ? "pr-12" : ""}`} />
        {showToggle && (
          <button type="button" onClick={onToggle} className="absolute right-3.5 top-1/2 -translate-y-1/2 text-[#8B7376] transition hover:text-[#7B1113]" tabIndex={-1}>
            {type === "text" ? (
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="h-5 w-5"><path strokeLinecap="round" strokeLinejoin="round" d="M2.036 12.322a1.012 1.012 0 0 1 0-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178Z" /><path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" /></svg>
            ) : (
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="h-5 w-5"><path strokeLinecap="round" strokeLinejoin="round" d="M3.98 8.223A10.477 10.477 0 0 0 1.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.451 10.451 0 0 1 12 4.5c4.756 0 8.773 3.162 10.065 7.498a10.522 10.522 0 0 1-4.293 5.774M6.228 6.228 3 3m3.228 3.228 3.65 3.65m7.894 7.894L21 21m-3.228-3.228-3.65-3.65m0 0a3 3 0 1 0-4.243-4.243m4.242 4.242L9.88 9.88" /></svg>
            )}
          </button>
        )}
      </div>
    </label>
  );
}

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<"login" | "forgot" | "update">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  useEffect(() => {
    const sb = getSupabase();
    const { data: authListener } = sb.auth.onAuthStateChange((event) => {
      if (event === "PASSWORD_RECOVERY") {
        setMode("update");
        setError("");
        setMessage("");
      }
    });
    return () => authListener.subscription.unsubscribe();
  }, []);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setMessage("");
    setLoading(true);

    try {
      const sb = getSupabase();
      const { data: authData, error: loginError } = await sb.auth.signInWithPassword({ email: email.trim(), password });

      if (loginError) {
        setError(loginError.message);
        setLoading(false);
        return;
      }

      const authUserId = authData?.user?.id;
      if (!authUserId) {
        setError("Login succeeded but could not identify user.");
        setLoading(false);
        return;
      }

      let userRows: { role: string; status: string }[] | null = null;
      let userError: { message: string } | null = null;

      ({ data: userRows, error: userError } = await sb
        .from("users")
        .select("role, status")
        .eq("auth_user_id", authUserId));

      if (userError) {
        setError("Failed to load user profile: " + userError.message);
        setLoading(false);
        return;
      }

      let staffRow = (userRows || []).find((u) => u.role !== "Student");
      let userData = staffRow || userRows?.[0];

      if (!userData) {
        // Fallback: look up by email (auth_user_id may be missing/mismatched)
        const byEmail = await sb
          .from("users")
          .select("role, status, auth_user_id")
          .eq("email", email.trim())
          .limit(5);
        const emailRows = byEmail.data || [];
        staffRow = emailRows.find((u) => u.role !== "Student");
        userData = staffRow || emailRows[0];
        if (userData && "auth_user_id" in userData && !userData.auth_user_id) {
          await sb.from("users").update({ auth_user_id: authUserId }).eq("email", email.trim()).is("auth_user_id", null);
        }
      }

      if (!userData) {
        // Last resort: create the profile from auth user_metadata (e.g. pre-seeded accounts)
        const meta = authData.user.user_metadata as Record<string, string | undefined> | null;
        const metaRole = meta?.role === "Admin" || meta?.role === "Faculty" || meta?.role === "CHED" ? meta.role : "Student";
        const ins = await sb.from("users").insert({
          auth_user_id: authUserId,
          email: authData.user.email || email.trim(),
          username: meta?.username || (authData.user.email || email.trim()).split("@")[0],
          role: metaRole,
          status: "Active",
        }).select("role, status").maybeSingle();
        if (ins.data) {
          userData = ins.data;
        } else {
          setError("No user profile found. Contact admin. (Your account exists in authentication but has no linked profile row.)");
          setLoading(false);
          return;
        }
      }

      if (userData.status === "Inactive") {
        setError("Your account is inactive. Please contact the Scholarship Office.");
        setLoading(false);
        return;
      }

      setLoading(false);
      const roleHome =
        userData.role === "Admin" ? "/admin"
          : userData.role === "CHED" ? "/ched"
            : userData.role === "Faculty" ? "/faculty"
              : "/student";

      const params = new URLSearchParams(window.location.search);
      const redirectPath = params.get("redirect");
      toast.success(`Signed in successfully — opening ${userData.role} dashboard.`);
      // Confirm that Supabase has persisted the session before navigating.
      // This avoids a mobile-browser race where the dashboard loads before
      // the auth cookie is available to the route guard.
      await sb.auth.getSession();
      if (redirectPath && redirectPath.startsWith(roleHome) && !redirectPath.startsWith("//") && !redirectPath.includes(":") && !redirectPath.includes("\\")) {
        window.location.assign(redirectPath);
        return;
      }
      window.location.assign(roleHome);
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      setError(errorMessage === "Failed to fetch"
        ? "Could not reach Supabase. Check your NEXT_PUBLIC_SUPABASE_URL, network connection, and Supabase project status."
        : errorMessage);
      setLoading(false);
    }
  };

  const handleForgotPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setMessage("");
    setLoading(true);

    const sb = getSupabase();
    const { error: resetError } = await sb.auth.resetPasswordForEmail(email.trim(), { redirectTo: `${window.location.origin}/login` });
    setLoading(false);

    if (resetError) { setError(resetError.message); return; }
    toast.success("If this email has an account, a password reset link has been sent.");
  };

  const handleUpdatePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setMessage("");

    if (newPassword.length < 8) { setError("Password must contain at least 8 characters."); return; }
    if (newPassword !== confirmPassword) { setError("Passwords do not match."); return; }

    setLoading(true);
    const sb = getSupabase();
    const { error: updateError } = await sb.auth.updateUser({ password: newPassword });
    setLoading(false);

    if (updateError) { setError(updateError.message); return; }
    setNewPassword("");
    setConfirmPassword("");
    setMode("login");
    toast.success("Password updated successfully. You can now log in.");
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

      {/* Left: brand / info panel */}
      <aside className="relative hidden w-[44%] flex-col justify-between overflow-hidden bg-gradient-to-br from-[#7B1113] via-[#5A0C0E] to-[#3E0009] p-12 text-white xl:flex 2xl:p-16">
        <div className="pointer-events-none absolute -right-28 -top-28 h-80 w-80 rounded-full bg-white/[0.06]" />
        <div className="pointer-events-none absolute -bottom-36 -left-24 h-96 w-96 rounded-full bg-black/20" />
        <div className="pointer-events-none absolute right-10 bottom-40 h-40 w-40 rounded-full bg-white/[0.04]" />

        <Link href="/" className="relative flex items-center gap-3">
          <img src="/logo.jpg" alt="St. Peter's College logo" className="h-11 w-11 flex-none rounded-xl bg-white object-contain shadow" />
          <span className="leading-tight">
            <span className="block text-base font-bold">St. Peter&rsquo;s College</span>
            <span className="block text-xs text-white/70">Iligan City</span>
          </span>
        </Link>

        <div className="relative">
          <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-white/60">ISEWM Scholarship System</p>
          <h1 className="mt-5 text-4xl font-bold leading-[1.15] 2xl:text-[2.6rem]">
            One system to apply, rank, approve &amp; monitor scholarships.
          </h1>
          <ul className="mt-9 space-y-4 text-sm text-white/85">
            {[
              "Ranked by financial need with a Random Forest model",
              "Verified against the Registrar Information System",
              "Early-warning alerts when grades fall below 93%",
              "One portal for Students, Faculty, CHED &amp; Admins",
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

      {/* Right: simple login box */}
      <main className="flex flex-1 items-center justify-center px-4 py-10 sm:px-8">
        <div className="w-full max-w-md">
          {/* Brand marker (small screens) */}
          <div className="mb-8 flex flex-col items-center lg:hidden">
            <img src="/logo.jpg" alt="St. Peter's College logo" className="h-12 w-12 flex-none rounded-xl bg-white object-contain shadow" />
            <span className="mt-3 block text-lg font-bold text-[#241012]">St. Peter&rsquo;s College</span>
            <span className="mt-0.5 block text-xs text-[#6B5458]">Scholarship System</span>
          </div>

          <div className="rounded-2xl border border-[#241012]/[0.06] bg-white p-8 shadow-[0_18px_50px_-20px_rgba(36,16,18,0.18)] sm:p-9">
            <h2 className="text-2xl font-bold tracking-tight text-[#241012]">
              {mode === "login" ? "Welcome back" : mode === "forgot" ? "Reset your password" : "Set a new password"}
            </h2>
            <p className="mt-2 text-sm leading-relaxed text-[#6B5458]">
              {mode === "login" ? "Sign in to your scholarship account." : mode === "forgot" ? "Enter your email and we will send you a secure reset link." : "Choose a strong password of at least 8 characters."}
            </p>

            {error && <div className="mt-5 flex gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"><span className="font-bold">!</span><p>{error}</p></div>}
            {message && <div className="mt-5 flex gap-3 rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700"><span className="font-bold">&#10003;</span><p>{message}</p></div>}

            <form onSubmit={mode === "login" ? handleLogin : mode === "forgot" ? handleForgotPassword : handleUpdatePassword} className="mt-6 space-y-4">
              {mode !== "update" && <Field label="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@student.com" icon="mail" />}
              {mode === "login" && <Field label="Password" type={showPassword ? "text" : "password"} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Enter your password" showToggle onToggle={() => setShowPassword(!showPassword)} icon="lock" />}
              {mode === "update" && (
                <>
                  <Field label="New Password" type={showPassword ? "text" : "password"} value={newPassword} onChange={(e) => setNewPassword(e.target.value)} placeholder="At least 8 characters" showToggle onToggle={() => setShowPassword(!showPassword)} icon="lock" />
                  <Field label="Confirm New Password" type={showPassword ? "text" : "password"} value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} placeholder="Enter the same password again" icon="lock" />
                </>
              )}
              <button type="submit" disabled={loading} className="w-full rounded-xl bg-gradient-to-r from-[#7B1113] to-[#540111] px-4 py-3 text-sm font-bold text-white shadow-md transition hover:brightness-110 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-60">
                {loading ? "Please wait..." : mode === "login" ? "Log In" : mode === "forgot" ? "Send Reset Link" : "Update Password"}
              </button>
            </form>

            {mode === "login" && (
              <div className="mt-5 text-center">
                <button type="button" onClick={() => { setMode("forgot"); setError(""); setMessage(""); }} className="text-sm font-semibold text-[#7B1113] transition hover:underline">Forgot password?</button>
              </div>
            )}

            <div className="mt-6 border-t border-[#241012]/[0.06] pt-5 text-center">
              {mode === "login" ? (
                <>
                  <p className="text-sm text-[#6B5458]">
                    No account yet?{" "}
                    <Link href="/register" className="font-semibold text-[#7B1113] transition hover:underline">Register</Link>
                  </p>
                  <p className="mt-2 text-[11px] leading-relaxed text-[#8B7376]">
                    By signing in you agree to the{" "}
                    <Link href="/terms" className="font-semibold text-[#7B1113] underline underline-offset-2 transition hover:brightness-110">
                      Terms and Conditions
                    </Link>{" "}
                    of the ISEWM Scholarship System.
                  </p>
                </>
              ) : (
                <button type="button" onClick={() => { setMode("login"); setError(""); setMessage(""); }} className="text-sm font-semibold text-[#7B1113] transition hover:underline">&larr; Back to login</button>
              )}
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}