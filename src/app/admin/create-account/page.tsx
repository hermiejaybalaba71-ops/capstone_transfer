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

    try {
      const sb = getSupabase();
      const { data: { session } } = await sb.auth.getSession();
      if (!session) throw new Error("Session expired. Please log in again.");

      const response = await fetch("/api/admin/create-faculty", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          username: form.username,
          email: form.email,
          password: form.password,
        }),
      });
      const result = (await response.json().catch(() => null)) as {
        ok?: boolean;
        message?: string;
        error?: string;
      } | null;
      if (!response.ok || !result?.ok) {
        throw new Error(result?.error || "Could not create the faculty account.");
      }

      setForm({ username: "", email: "", password: "" });
      setIsError(false);
      setMessage(result.message || "Faculty account created successfully.");
      toast.success(result.message || "Faculty account created successfully.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not create the faculty account.");
      setIsError(true);
    } finally {
      setCreating(false);
    }
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
