"use client";
import toast from "react-hot-toast";

import { useState } from "react";
import { getSupabase } from "@/lib/supabase/browser";

export default function CreateFacultyAccountPage() {
  const [form, setForm] = useState({ username: "", email: "", password: "" });
  const [creating, setCreating] = useState(false);
  const [message, setMessage] = useState("");
  const [isError, setIsError] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setMessage("");
    setIsError(false);
    setCreating(true);

    const sb = getSupabase();

    const { data: signUp, error: signUpError } = await sb.auth.signUp({
      email: form.email.trim(),
      password: form.password,
      options: { data: { role: "Faculty" } },
    });

    if (signUpError) {
      setMessage(signUpError.message);
      setIsError(true);
      setCreating(false);
      return;
    }

    const authUserId = signUp.user?.id;
    if (!authUserId) {
      setMessage("Account created but we could not link the staff record. Please contact support.");
      setIsError(true);
      setCreating(false);
      return;
    }

    // The handle_new_student_registration DB trigger fires on every auth user creation
    // and hardcodes role='Student', producing a duplicate/wrong users row for staff.
    // Delete any trigger-created row before upserting the correct Faculty record.
    await sb
      .from("users")
      .delete()
      .eq("auth_user_id", authUserId)
      .eq("role", "Student");

    const { error: insertError } = await sb.from("users").upsert(
      {
        username: form.username.trim(),
        email: form.email.trim(),
        role: "Faculty",
        auth_user_id: authUserId,
        status: "Active",
      },
      { onConflict: "auth_user_id" }
    );

    setCreating(false);

    if (insertError) {
      setMessage(insertError.message);
      setIsError(true);
      return;
    }

    setForm({ username: "", email: "", password: "" });
    setIsError(false);
    setMessage("Faculty account created successfully.");
    toast.success("Faculty account created successfully.");
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-[#241012]">Create Faculty Account</h1>
          <p className="mt-1 text-xs text-[#8B7376]">Set up a faculty member so they can monitor and support scholars.</p>
        </div>
      </div>

      <div className="max-w-lg rounded-xl border border-[#241012]/[0.06] bg-white p-5 shadow-sm">
        <form onSubmit={handleSubmit} className="space-y-4">
          <label className="block text-xs font-semibold text-[#241012]">
            Username
            <input
              type="text"
              value={form.username}
              onChange={(e) => setForm({ ...form, username: e.target.value })}
              required
              className="mt-1 w-full rounded-lg border border-[#241012]/[0.06] bg-white px-3 py-2.5 text-xs outline-none focus:border-[#7B1113]"
              placeholder="e.g. jpdelacruz"
            />
          </label>

          <label className="block text-xs font-semibold text-[#241012]">
            Email
            <input
              type="email"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
              required
              className="mt-1 w-full rounded-lg border border-[#241012]/[0.06] bg-white px-3 py-2.5 text-xs outline-none focus:border-[#7B1113]"
              placeholder="faculty@spc.edu.ph"
            />
          </label>

          <label className="block text-xs font-semibold text-[#241012]">
            Password
            <input
              type="password"
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
              required
              minLength={6}
              className="mt-1 w-full rounded-lg border border-[#241012]/[0.06] bg-white px-3 py-2.5 text-xs outline-none focus:border-[#7B1113]"
              placeholder="Minimum 6 characters"
            />
          </label>

          {message && (
            <div
              className={`rounded-lg px-4 py-3 text-xs font-medium ${
                isError
                  ? "border border-red-200 bg-red-50 text-red-700"
                  : "border border-green-200 bg-green-50 text-green-700"
              }`}
            >
              {message}
            </div>
          )}

          <button
            type="submit"
            disabled={creating}
            className="rounded-lg bg-[#7B1113] px-4 py-2.5 text-xs font-bold text-white hover:bg-[#540111] disabled:opacity-50"
          >
            {creating ? "Creating..." : "Create Faculty Account"}
          </button>
        </form>
      </div>
    </div>
  );
}
