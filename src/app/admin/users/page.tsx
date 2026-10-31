"use client";
import toast from "react-hot-toast";

import { useEffect, useState, useMemo, useCallback } from "react";
import { useRouter } from "next/navigation";
import { getSupabase } from "@/lib/supabase/browser";
import { queryRegistrar } from "@/lib/supabase/registrar";
import { formatDate } from "@/lib/utils";
import { STATUS_STYLES, PROGRAMS, YEAR_LEVELS } from "@/lib/constants";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { Spinner } from "@/components/ui/spinner";

// Compact display for long degree names: "Bachelor of Science in Information
// Technology" -> "BSIT" — full name shown on hover / title.
function shortProgram(name?: string | null) {
  if (!name || name === "—") return "—";
  const m = name.match(/Bachelor of (Science|Arts) in (.*)/i);
  if (!m) return name;
  const deg = m[1].toLowerCase().startsWith("art") ? "BA" : "BS";
  const initials = m[2]
    .replace(/[^A-Za-z ]/g, "")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase())
    .join("");
  return `${deg}${initials || ""}`;
}

function shortYear(name?: string | null) {
  return (name || "—").replace(/ Year$/i, "").trim();
}

const SEX_INITIAL = (s?: string | null) => (s ? s.charAt(0).toUpperCase() : "—");

interface User {
  user_id: number;
  auth_user_id?: string;
  username: string;
  email: string;
  role: string;
  status: string;
  created_at?: string;
}

interface StudentDetail {
  user_id: number;
  student_id: number;
  student_number: string;
  given_name: string;
  last_name: string;
  middle_name?: string;
  ext_name?: string;
  program_name?: string;
  year_level?: string;
  sex?: string;
  birthdate?: string;
  registration_status?: string;
}

interface EditForm {
  username: string;
  email: string;
  student_number: string;
  given_name: string;
  last_name: string;
  middle_name: string;
  ext_name: string;
  sex: string;
  birthdate: string;
  program_name: string;
  year_level: string;
}

export default function UserManagementPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [users, setUsers] = useState<User[]>([]);
  const [students, setStudents] = useState<StudentDetail[]>([]);
  const [me, setMe] = useState<User | null>(null);
  const [message, setMessage] = useState("");
  const [messageType, setMessageType] = useState<"ok" | "err" | "">("");
  const [search, setSearch] = useState("");
  const [verifyingId, setVerifyingId] = useState<number | null>(null);
  const [editingUserId, setEditingUserId] = useState<number | null>(null);
  const [editForm, setEditForm] = useState<EditForm | null>(null);
  const [savingEdit, setSavingEdit] = useState(false);
  const [deletingUserId, setDeletingUserId] = useState<number | null>(null);

  useEffect(() => {
    let ignore = false;
    async function startFetching() {
      const sb = getSupabase();
      const { data: { session } } = await sb.auth.getSession();
      if (!session) { router.push("/login"); return; }

      const meQ = await sb.from("users").select("*").eq("auth_user_id", session.user.id).maybeSingle();
      if (!meQ.error && meQ.data) setMe(meQ.data);

      const [usersQ, studentsQ] = await Promise.all([
        sb.from("users").select("*").order("created_at", { ascending: false }),
        sb.from("student_accounts").select("user_id, student_id, student_number, given_name, last_name, middle_name, ext_name, program_name, year_level, sex, birthdate, registration_status"),
      ]);

      if (!usersQ.error) setUsers(usersQ.data || []);
      if (!studentsQ.error) setStudents(studentsQ.data || []);
      if (!ignore) setLoading(false);
    }
    startFetching();
    return () => { ignore = true; };
  }, [router]);

  const getStudent = useCallback((userId: number): StudentDetail | undefined => {
    return students.find((s) => s.user_id === userId);
  }, [students]);

  const filteredUsers = useMemo(() => {
    if (!search.trim()) return users;
    const q = search.toLowerCase();
    return users.filter((u) => {
      if (u.username.toLowerCase().includes(q)) return true;
      if (u.email.toLowerCase().includes(q)) return true;
      if (u.role.toLowerCase().includes(q)) return true;
      const s = getStudent(u.user_id);
      if (s) {
        if (`${s.given_name} ${s.last_name}`.toLowerCase().includes(q)) return true;
        if (s.student_number?.toLowerCase().includes(q)) return true;
        if (s.program_name?.toLowerCase().includes(q)) return true;
        if (s.year_level?.toLowerCase().includes(q)) return true;
        if (s.sex?.toLowerCase().includes(q)) return true;
      }
      return false;
    });
  }, [users, getStudent, search]);

  async function handleRoleChange(user: User, newRole: string) {
    setMessage("");
    setMessageType("");
    const sb = getSupabase();
    const { error } = await sb.from("users").update({ role: newRole }).eq("user_id", user.user_id);
    if (error) { setMessage(error.message); setMessageType("err"); return; }
    setUsers((prev) => prev.map((u) => u.user_id === user.user_id ? { ...u, role: newRole } : u));
  }

  async function handleToggleStatus(user: User) {
    setMessage("");
    setMessageType("");
    const nextStatus = user.status === "Active" ? "Inactive" : "Active";
    if (nextStatus === "Inactive") {
      const ok = window.confirm(`Are you sure you want to deactivate ${user.username}?`);
      if (!ok) return;
    }
    const sb = getSupabase();
    const { error } = await sb.from("users").update({ status: nextStatus }).eq("user_id", user.user_id);
    if (error) { setMessage(error.message); setMessageType("err"); return; }
    setUsers((prev) => prev.map((u) => u.user_id === user.user_id ? { ...u, status: nextStatus } : u));
  }

  async function handleVerify(user: User, student: StudentDetail | undefined) {
    setMessage("");
    setMessageType("");
    if (!student || !student.student_number) {
      setMessage("No student record linked to this account, so it cannot be verified against the Registrar.");
      setMessageType("err");
      return;
    }
    setVerifyingId(user.user_id);
    const regLookup = await queryRegistrar<{ student_id: number; registration_status?: string }>((rsb) =>
      rsb
        .from("registrar_students")
        .select("*")
        .eq("student_number", student.student_number.trim())
        .maybeSingle()
    );

    if (regLookup.error) {
      setVerifyingId(null);
      setMessage(`Registrar lookup failed: ${regLookup.error.message}`);
      setMessageType("err");
      return;
    }

    const regRows = regLookup.data;
    let isEnrolled = false;
    if (regRows) {
      isEnrolled = !!regRows.registration_status && regRows.registration_status === "Enrolled";
      if (!isEnrolled) {
        const enrollLookup = await queryRegistrar<{ enrollment_status: string }[]>((rsb) =>
          rsb
            .from("registrar_enrollment")
            .select("enrollment_status")
            .eq("student_id", regRows.student_id)
            .eq("enrollment_status", "Enrolled")
            .limit(1)
        );
        if (!enrollLookup.error) isEnrolled = !!enrollLookup.data?.length;
      }
    }

    if (!regRows || !isEnrolled) {
      setVerifyingId(null);
      setMessage(`No enrolled record found in the Registrar database for student number ${student.student_number}. The account stays Unverified.`);
      setMessageType("err");
      return;
    }

    const sb = getSupabase();
    const { error: updateErr } = await sb
      .from("student_accounts")
      .update({ registration_status: "Verified" })
      .eq("student_id", student.student_id);

    setVerifyingId(null);

    if (updateErr) {
      setMessage(`Record found in Registrar but could not update status: ${updateErr.message}`);
      setMessageType("err");
      return;
    }

    setStudents((prev) => prev.map((s) => s.student_id === student.student_id ? { ...s, registration_status: "Verified" } : s));
    setMessage(`Verified from Registrar — ${student.given_name} ${student.last_name} matched an enrolled record (${student.student_number}).`);
    setMessageType("ok");
  }

  function openEdit(user: User, student: StudentDetail | undefined) {
    setEditingUserId(user.user_id);
    setEditForm({
      username: user.username,
      email: user.email || "",
      student_number: student?.student_number || "",
      given_name: student?.given_name || "",
      last_name: student?.last_name || "",
      middle_name: student?.middle_name || "",
      ext_name: student?.ext_name || "",
      sex: student?.sex || "",
      birthdate: student?.birthdate || "",
      program_name: student?.program_name || "",
      year_level: student?.year_level || "",
    });
  }

  async function handleEditSave(e: React.FormEvent) {
    e.preventDefault();
    if (!editForm || editingUserId === null) return;
    setMessage("");
    setMessageType("");
    setSavingEdit(true);
    const sb = getSupabase();

    const { data: studentRow } = await sb
      .from("student_accounts")
      .select("student_id, given_name, last_name")
      .eq("user_id", editingUserId)
      .maybeSingle();

    if (studentRow) {
      const { error: saErr } = await sb
        .from("student_accounts")
        .update({
          student_number: editForm.student_number.trim() || null,
          given_name: editForm.given_name.trim() || null,
          last_name: editForm.last_name.trim() || null,
          middle_name: editForm.middle_name.trim() || null,
          ext_name: editForm.ext_name.trim() || null,
          sex: editForm.sex || null,
          birthdate: editForm.birthdate || null,
          program_name: editForm.program_name || null,
          year_level: editForm.year_level || null,
        })
        .eq("student_id", studentRow.student_id);
      if (saErr) {
        setSavingEdit(false);
        setMessage(saErr.message);
        setMessageType("err");
        return;
      }
      setStudents((prev) => prev.map((s) => s.student_id === studentRow.student_id ? {
        ...s,
        student_number: editForm.student_number.trim() || s.student_number,
        given_name: editForm.given_name.trim() || s.given_name,
        last_name: editForm.last_name.trim() || s.last_name,
        middle_name: editForm.middle_name.trim() || undefined,
        ext_name: editForm.ext_name.trim() || undefined,
        sex: editForm.sex || undefined,
        birthdate: editForm.birthdate || undefined,
        program_name: editForm.program_name || undefined,
        year_level: editForm.year_level || undefined,
      } : s));
    }

    const { error: uErr } = await sb
      .from("users")
      .update({ username: editForm.username.trim(), email: editForm.email.trim() })
      .eq("user_id", editingUserId);
    if (uErr) {
      setSavingEdit(false);
      setMessage(uErr.message);
      setMessageType("err");
      return;
    }
    setUsers((prev) => prev.map((u) => u.user_id === editingUserId ? { ...u, username: editForm.username.trim(), email: editForm.email.trim() } : u));

    setSavingEdit(false);
    setEditingUserId(null);
    setEditForm(null);
    setMessage("Account details updated successfully.");
    toast.success("Account details updated successfully.");
    setMessageType("ok");
  }

  async function handleDelete(user: User) {
    setMessage("");
    setMessageType("");
    const label = user.email || user.username;
    const ok = window.confirm(
      `Delete "${label}" permanently?\n\nThis removes the user profile, linked student account (if any), applications, and login credentials. This cannot be undone.`
    );
    if (!ok) return;

    setDeletingUserId(user.user_id);
    try {
      const sb = getSupabase();
      const { data: { session } } = await sb.auth.getSession();
      if (!session) {
        setMessage("Session expired. Please log in again.");
        setMessageType("err");
        return;
      }

      const res = await fetch("/api/admin/delete-user", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ user_id: user.user_id }),
      });
      const payload = await res.json().catch(() => ({ error: "Invalid server response." }));

      if (!res.ok || payload.error) {
        setMessage(payload.error || "Could not delete this user.");
        setMessageType("err");
        return;
      }

      setUsers((prev) => prev.filter((u) => u.user_id !== user.user_id));
      setStudents((prev) => prev.filter((s) => s.user_id !== user.user_id));
      setMessage(
        `Deleted "${label}"${payload.auth_deleted ? " (login removed)" : " (profile removed)"}.`
      );
      setMessageType("ok");
    } catch (err: unknown) {
      setMessage(err instanceof Error ? err.message : "Delete failed.");
      setMessageType("err");
    } finally {
      setDeletingUserId(null);
    }
  }

  function exportCsv() {
    const headers = ["Username", "Email", "Role", "Status", "Created", "Student Number", "Full Name", "Program", "Year Level", "Sex", "Registration Status"];
    const rows = filteredUsers.map((u) => {
      const s = getStudent(u.user_id);
      return [
        u.username,
        u.email,
        u.role,
        u.status,
        formatDate(u.created_at),
        s?.student_number ?? "",
        s ? `${s.last_name}, ${s.given_name}` : "",
        s?.program_name ?? "",
        s?.year_level ?? "",
        s?.sex ?? "",
        s?.registration_status ?? "",
      ];
    });
    const csv = [headers, ...rows].map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\n");
    const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `users_export_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  if (loading) return <Spinner label="Loading users..." color="maroon" />;

  const roles = ["Admin", "Faculty", "Student", "CHED"];

  const activeCount = users.filter((u) => u.status === "Active").length;
  const inactiveCount = users.length - activeCount;
  const studentCount = users.filter((u) => u.role === "Student").length;

  // Same cell padding/borders the Documents Viewer table uses, so both pages
  // read as one design system.
  const cellCls = "border border-[#241012]/10 px-3 py-1.5 align-middle";

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h1 className="text-xl font-bold text-[#241012]">User Management</h1>
          <p className="mt-1 text-xs text-[#8B7376]">Manage accounts, roles, and status for every user in the system.</p>
        </div>
        <button
          onClick={exportCsv}
          className="flex items-center gap-2 self-start rounded-xl bg-gradient-to-r from-[#7B1113] to-[#540111] px-4 py-2.5 text-xs font-bold text-white shadow-md transition hover:brightness-110"
        >
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
          </svg>
          Export CSV
        </button>
      </div>

      {message && (
        <div className={`rounded-xl border px-4 py-3 text-xs font-medium shadow-sm ${messageType === "err" ? "border-red-200 bg-red-50 text-red-700" : "border-green-200 bg-green-50 text-green-700"}`}>
          {message}
        </div>
      )}

      {users.length === 0 ? (
        <EmptyState icon="&#128101;" title={search ? "No users match your search" : "No users found"} />
      ) : (
        <div className="overflow-hidden rounded-2xl border border-[#241012]/[0.07] bg-white shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#241012]/[0.07] bg-gradient-to-r from-[#FAF7F5] to-white px-5 py-4">
            <div>
              <p className="text-sm font-bold text-[#241012]">User Accounts</p>
              <p className="mt-0.5 text-[11px] text-[#6B5458]">
                {filteredUsers.length} of {users.length} account{users.length === 1 ? "" : "s"} shown &middot;{" "}
                <span className="font-semibold text-[#7B1113]">{activeCount} active</span>
                {" \u00b7 "}
                <span className="text-[#6B5458]">One row per account — change the role, verify, deactivate or edit from the Actions column</span>
              </p>
            </div>
            <div className="relative w-full sm:max-w-xs">
              <svg className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#8B7376]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              <input
                type="text"
                placeholder="Search by name, username, email, student number, program, year, sex..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full rounded-xl border border-[#241012]/10 bg-white py-2.5 pl-9 pr-3 text-xs outline-none transition focus:border-[#7B1113] focus:ring-4 focus:ring-[#7B1113]/10"
              />
            </div>
          </div>

          {filteredUsers.length === 0 ? (
            <p className="px-5 py-8 text-center text-xs text-[#8B7376]">No users match this search.</p>
          ) : (
            <div className="max-h-[70vh] overflow-auto">
              <table className="w-full min-w-[980px] border-collapse text-left text-[11px] text-[#241012]">
                <thead className="sticky top-0 z-10 bg-[#FAF7F5] text-[10px] uppercase tracking-wide text-[#6B5458] shadow-[0_1px_0_0_rgba(36,16,18,0.07)]">
                  <tr>
                    <th className={`${cellCls} w-12 text-center font-bold`}>#</th>
                    <th className={`${cellCls} font-bold`}>Username</th>
                    <th className={`${cellCls} font-bold`}>Email</th>
                    <th className={`${cellCls} font-bold`}>Role</th>
                    <th className={`${cellCls} font-bold`}>Status</th>
                    {filteredUsers.some((u) => u.role === "Student") && (
                      <>
                        <th className={`${cellCls} font-bold`}>Student #</th>
                        <th className={`${cellCls} font-bold`}>Full Name</th>
                        <th className={`${cellCls} font-bold`}>Program</th>
                        <th className={`${cellCls} font-bold`}>Year</th>
                        <th className={`${cellCls} font-bold`}>Sex</th>
                        <th className={`${cellCls} font-bold`}>Registrar</th>
                      </>
                    )}
                    <th className={`${cellCls} font-bold`}>Created</th>
                    <th className={`${cellCls} w-64 font-bold`}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredUsers.map((u, i) => {
                    const isMe = me?.user_id === u.user_id;
                    const s = getStudent(u.user_id);
                    return (
                      <tr key={u.user_id} className={`${i % 2 ? "bg-[#FAF7F5]/60" : "bg-white"}${u.status === "Inactive" ? " opacity-50" : ""}`}>
                        <td className={`${cellCls} text-center font-bold text-[#6B5458]`}>{i + 1}</td>
                        <td className={`${cellCls} whitespace-nowrap font-semibold`}>{u.username}</td>
                        <td className={`${cellCls} whitespace-nowrap text-[#6B5458]`}>{u.email}</td>
                        <td className={cellCls}>
                          <select
                            value={u.role}
                            onChange={(e) => handleRoleChange(u, e.target.value)}
                            disabled={isMe}
                            className="rounded-lg border border-[#241012]/10 bg-white px-1.5 py-1 text-[11px] outline-none transition focus:border-[#7B1113] focus:ring-4 focus:ring-[#7B1113]/10 disabled:cursor-not-allowed"
                          >
                            {roles.map((r) => <option key={r}>{r}</option>)}
                          </select>
                          {isMe && <span className="ml-1 text-[10px] text-[#8B7376]">(you)</span>}
                        </td>
                        <td className={cellCls}>
                          <Badge className={STATUS_STYLES[u.status] || (u.status === "Active" ? "border-green-200 bg-green-50 text-green-700" : "border-[#241012]/[0.06] bg-[#F3EEEB] text-[#6B5458]")}>
                            {u.status}
                          </Badge>
                        </td>
                        {filteredUsers.some((usr) => usr.role === "Student") && (
                          <>
                            <td className={`${cellCls} whitespace-nowrap font-mono text-[11px]`}>{s?.student_number || "—"}</td>
                            <td className={`${cellCls} whitespace-nowrap`}>
                              {s ? (
                                <span className="font-medium">{s.last_name}, {s.given_name}{s.ext_name ? ` ${s.ext_name}` : ""}</span>
                              ) : "—"}
                            </td>
                            <td className={`${cellCls} whitespace-nowrap text-[#6B5458]`} title={s?.program_name || ""}>{shortProgram(s?.program_name)}</td>
                            <td className={`${cellCls} text-[#6B5458]`} title={s?.year_level || ""}>{shortYear(s?.year_level)}</td>
                            <td className={`${cellCls} text-[#6B5458]`} title={s?.sex || ""}>{SEX_INITIAL(s?.sex)}</td>
                            <td className={cellCls}>
                              {s ? (
                                s.registration_status === "Verified" ? (
                                  <Badge className="border-green-200 bg-green-50 text-green-700">
                                  <span title="Record matched in the Registrar database">&#10003; Verified</span>
                                </Badge>
                                ) : (
                                  <Badge className="border-amber-200 bg-amber-50 text-amber-700">
                                    Unverified
                                  </Badge>
                                )
                              ) : (
                                <span className="text-[#8B7376]">—</span>
                              )}
                            </td>
                          </>
                        )}
                        <td className={`${cellCls} whitespace-nowrap text-[#8B7376]`}>{formatDate(u.created_at)}</td>
                        <td className={cellCls}>
                          <div className="flex flex-row flex-wrap items-center gap-1.5">
                            <button
                              onClick={() => openEdit(u, s)}
                              disabled={isMe}
                              className="rounded-md bg-[#7B1113] px-2.5 py-1 text-[10px] font-bold text-white transition hover:bg-[#540111] disabled:cursor-not-allowed disabled:opacity-50"
                              title="Update this account's details"
                            >
                              Edit
                            </button>
                            {s && s.registration_status !== "Verified" && (
                              <button
                                onClick={() => handleVerify(u, s)}
                                disabled={isMe || verifyingId === u.user_id}
                                className="rounded-md border border-[#7B1113]/25 px-2.5 py-1 text-[10px] font-bold text-[#7B1113] transition hover:bg-[#7B1113]/5 disabled:cursor-not-allowed disabled:opacity-50"
                                title="Automatically check against the Registrar database and mark Verified"
                              >
                                {verifyingId === u.user_id ? "Checking Registrar..." : "Verify"}
                              </button>
                            )}
                            <button
                              onClick={() => handleToggleStatus(u)}
                              disabled={isMe}
                              className={`rounded-md px-2.5 py-1 text-[10px] font-bold transition disabled:cursor-not-allowed disabled:opacity-50 ${
                                u.status === "Active"
                                  ? "border border-red-200 text-red-600 hover:bg-red-50"
                                  : "border border-[#7B1113]/25 text-[#7B1113] hover:bg-[#7B1113]/5"
                              }`}
                            >
                              {u.status === "Active" ? "Deactivate" : "Activate"}
                            </button>
                            <button
                              onClick={() => handleDelete(u)}
                              disabled={isMe || deletingUserId === u.user_id}
                              className="rounded-md border border-red-200 px-2.5 py-1 text-[10px] font-bold text-red-600 transition hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50"
                              title="Permanently delete this account, linked records, and login"
                            >
                              {deletingUserId === u.user_id ? "Deleting..." : "Delete"}
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-[#241012]/[0.07] bg-[#FAF7F5] px-5 py-2.5 text-[10px] text-[#6B5458]">
            <span>Total accounts <b className="text-[#7B1113]">{users.length}</b></span>
            <span>Active <b className="text-[#7B1113]">{activeCount}</b></span>
            <span>Inactive <b className="text-[#7B1113]">{inactiveCount}</b></span>
            <span>Student accounts <b className="text-[#7B1113]">{studentCount}</b></span>
            <span className="ml-auto">Showing <b className="text-[#7B1113]">{filteredUsers.length}</b> of {users.length} users</span>
          </div>
        </div>
      )}

      {editingUserId !== null && editForm && (
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center bg-black/70 p-4"
          onClick={() => { setEditingUserId(null); setEditForm(null); }}
        >
          <div
            className="flex max-h-[88vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3 border-b border-[#241012]/[0.06] px-5 py-4">
              <div className="min-w-0">
                <h3 className="truncate text-base font-bold text-[#241012]">Edit User Account</h3>
                <p className="mt-0.5 text-[11px] text-[#8B7376]">
                  Update these details when the student reports a mistake. Changes apply to their record in the system.
                </p>
              </div>
              <button
                onClick={() => { setEditingUserId(null); setEditForm(null); }}
                className="rounded-full p-1 text-lg leading-none text-[#8B7376] transition hover:bg-[#7B1113]/5 hover:text-[#7B1113]"
              >
                &times;
              </button>
            </div>

            <form onSubmit={handleEditSave} className="flex min-h-0 flex-1 flex-col">
              <div className="max-h-[55vh] overflow-auto">
                <div className="border-b border-[#241012]/[0.06] bg-white px-5 py-4">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className="block text-xs font-semibold text-[#241012] sm:col-span-2">
                      Username
                      <input
                        type="text"
                        value={editForm.username}
                        onChange={(e) => setEditForm({ ...editForm, username: e.target.value })}
                        required
                        className="mt-1 w-full rounded-lg border border-[#241012]/10 px-3 py-2 text-xs outline-none transition focus:border-[#7B1113] focus:ring-4 focus:ring-[#7B1113]/10"
                      />
                    </label>
                    <label className="block text-xs font-semibold text-[#241012] sm:col-span-2">
                      Email
                      <input
                        type="email"
                        value={editForm.email}
                        onChange={(e) => setEditForm({ ...editForm, email: e.target.value })}
                        required
                        className="mt-1 w-full rounded-lg border border-[#241012]/10 px-3 py-2 text-xs outline-none transition focus:border-[#7B1113] focus:ring-4 focus:ring-[#7B1113]/10"
                      />
                    </label>
                  </div>
                </div>

                <div className="border-b border-[#241012]/[0.06] bg-[#FAF7F5]/60 px-5 py-4">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className="block text-xs font-semibold text-[#241012]">
                      Student Number
                      <input
                        type="text"
                        value={editForm.student_number}
                        onChange={(e) => setEditForm({ ...editForm, student_number: e.target.value })}
                        placeholder="e.g. 2026-00010"
                        className="mt-1 w-full rounded-lg border border-[#241012]/10 px-3 py-2 text-xs outline-none transition focus:border-[#7B1113] focus:ring-4 focus:ring-[#7B1113]/10"
                      />
                    </label>
                    <label className="block text-xs font-semibold text-[#241012]">
                      Given Name
                      <input
                        type="text"
                        value={editForm.given_name}
                        onChange={(e) => setEditForm({ ...editForm, given_name: e.target.value })}
                        required
                        className="mt-1 w-full rounded-lg border border-[#241012]/10 px-3 py-2 text-xs outline-none transition focus:border-[#7B1113] focus:ring-4 focus:ring-[#7B1113]/10"
                      />
                    </label>
                    <label className="block text-xs font-semibold text-[#241012]">
                      Last Name
                      <input
                        type="text"
                        value={editForm.last_name}
                        onChange={(e) => setEditForm({ ...editForm, last_name: e.target.value })}
                        required
                        className="mt-1 w-full rounded-lg border border-[#241012]/10 px-3 py-2 text-xs outline-none transition focus:border-[#7B1113] focus:ring-4 focus:ring-[#7B1113]/10"
                      />
                    </label>
                    <label className="block text-xs font-semibold text-[#241012]">
                      Middle Name
                      <input
                        type="text"
                        value={editForm.middle_name}
                        onChange={(e) => setEditForm({ ...editForm, middle_name: e.target.value })}
                        placeholder="Optional"
                        className="mt-1 w-full rounded-lg border border-[#241012]/10 px-3 py-2 text-xs outline-none transition focus:border-[#7B1113] focus:ring-4 focus:ring-[#7B1113]/10"
                      />
                    </label>
                    <label className="block text-xs font-semibold text-[#241012]">
                      Extension Name
                      <input
                        type="text"
                        value={editForm.ext_name}
                        onChange={(e) => setEditForm({ ...editForm, ext_name: e.target.value })}
                        placeholder="Jr., III..."
                        className="mt-1 w-full rounded-lg border border-[#241012]/10 px-3 py-2 text-xs outline-none transition focus:border-[#7B1113] focus:ring-4 focus:ring-[#7B1113]/10"
                      />
                    </label>
                    <label className="block text-xs font-semibold text-[#241012]">
                      Sex
                      <select
                        value={editForm.sex}
                        onChange={(e) => setEditForm({ ...editForm, sex: e.target.value })}
                        className="mt-1 w-full rounded-lg border border-[#241012]/10 px-3 py-2 text-xs outline-none transition focus:border-[#7B1113] focus:ring-4 focus:ring-[#7B1113]/10"
                      >
                        <option value="">Select sex...</option>
                        <option value="Male">Male</option>
                        <option value="Female">Female</option>
                      </select>
                    </label>
                    <label className="block text-xs font-semibold text-[#241012]">
                      Birthdate
                      <input
                        type="date"
                        value={editForm.birthdate}
                        max={new Date().toISOString().split("T")[0]}
                        onChange={(e) => setEditForm({ ...editForm, birthdate: e.target.value })}
                        className="mt-1 w-full rounded-lg border border-[#241012]/10 px-3 py-2 text-xs outline-none transition focus:border-[#7B1113] focus:ring-4 focus:ring-[#7B1113]/10"
                      />
                    </label>
                    <label className="block text-xs font-semibold text-[#241012] sm:col-span-2">
                      Program
                      <select
                        value={editForm.program_name}
                        onChange={(e) => setEditForm({ ...editForm, program_name: e.target.value })}
                        className="mt-1 w-full rounded-lg border border-[#241012]/10 px-3 py-2 text-xs outline-none transition focus:border-[#7B1113] focus:ring-4 focus:ring-[#7B1113]/10"
                      >
                        <option value="">Select program...</option>
                        {PROGRAMS.map((p) => <option key={p} value={p}>{p}</option>)}
                      </select>
                    </label>
                    <label className="block text-xs font-semibold text-[#241012]">
                      Year Level
                      <select
                        value={editForm.year_level}
                        onChange={(e) => setEditForm({ ...editForm, year_level: e.target.value })}
                        className="mt-1 w-full rounded-lg border border-[#241012]/10 px-3 py-2 text-xs outline-none transition focus:border-[#7B1113] focus:ring-4 focus:ring-[#7B1113]/10"
                      >
                        <option value="">Select year level...</option>
                        {YEAR_LEVELS.map((y) => <option key={y} value={y}>{y}</option>)}
                      </select>
                    </label>
                  </div>
                </div>
              </div>

              <div className="flex flex-wrap items-center justify-end gap-2 border-t border-[#241012]/[0.06] px-5 py-3">
                <button
                  type="button"
                  onClick={() => { setEditingUserId(null); setEditForm(null); }}
                  disabled={savingEdit}
                  className="rounded-xl border border-[#7B1113]/30 px-4 py-2 text-xs font-bold text-[#7B1113] transition hover:bg-[#7B1113]/5 disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={savingEdit}
                  className="rounded-xl bg-gradient-to-r from-[#7B1113] to-[#540111] px-4 py-2 text-xs font-bold text-white shadow-md transition hover:brightness-110 disabled:opacity-50"
                >
                  {savingEdit ? "Saving..." : "Save Changes"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
