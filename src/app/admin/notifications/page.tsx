"use client";
import toast from "react-hot-toast";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getSupabase } from "@/lib/supabase/browser";
import { formatDateTime, downloadCsv } from "@/lib/utils";
import { NOTIFICATION_TYPE_STYLES } from "@/lib/constants";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { Spinner } from "@/components/ui/spinner";

interface StudentAccount {
  student_id: number;
  given_name?: string;
  last_name?: string;
  student_number?: string;
}

interface Notification {
  notification_id: number;
  student_id: number;
  title: string;
  message: string;
  notification_type: string;
  date_sent: string;
  status?: string;
  student_accounts?: { given_name?: string; last_name?: string; student_number?: string };
}

const NOTIFICATION_TYPES = ["Announcement", "Status Update"];

export default function NotificationsPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [students, setStudents] = useState<StudentAccount[]>([]);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [message, setMessage] = useState<{ type: "ok" | "err"; text: string } | null>(null);

  const [recipientMode, setRecipientMode] = useState<"all" | "student">("all");
  const [form, setForm] = useState({ student_id: "", title: "", message: "", notification_type: "Announcement" });
  const [sending, setSending] = useState(false);
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 8;

  useEffect(() => {
    let ignore = false;
    async function startFetching() {
      const sb = getSupabase();
      const { data: { session } } = await sb.auth.getSession();
      if (!session) { router.push("/login"); return; }

      const [studentsQ, notifQ] = await Promise.all([
        sb.from("student_accounts").select("student_id, given_name, last_name, student_number").order("last_name", { ascending: true }),
        sb.from("notifications_announcements").select("*, student_accounts(given_name, last_name, student_number)").order("date_sent", { ascending: false }),
      ]);

      if (!studentsQ.error) setStudents(studentsQ.data || []);
      if (!notifQ.error) setNotifications(notifQ.data || []);
      if (!ignore) setLoading(false);
    }
    startFetching();
    return () => { ignore = true; };
  }, [router]);

  function refreshNotifications() {
    const sb = getSupabase();
    sb.from("notifications_announcements")
      .select("*, student_accounts(given_name, last_name, student_number)")
      .order("date_sent", { ascending: false })
      .then(({ data }) => { if (data) setNotifications(data); });
  }

  const recipientName = students.find((s) => String(s.student_id) === form.student_id);

  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    setMessage(null);
    if (!form.title.trim() || !form.message.trim()) {
      setMessage({ type: "err", text: "Please add a title and a message." });
      return;
    }
    if (recipientMode === "student" && !form.student_id) {
      setMessage({ type: "err", text: "Please choose the student you want to notify." });
      return;
    }

    setSending(true);
    const sb = getSupabase();

    let rows: { student_id: number; title: string; message: string; notification_type: string; status: string }[] = [];
    if (recipientMode === "all") {
      rows = students.map((s) => ({
        student_id: s.student_id,
        title: form.title.trim(),
        message: form.message.trim(),
        notification_type: form.notification_type,
        status: "Unread",
      }));
      if (!rows.length) {
        setSending(false);
        setMessage({ type: "err", text: "No students available to notify yet." });
        return;
      }
    } else {
      rows = [{
        student_id: Number(form.student_id),
        title: form.title.trim(),
        message: form.message.trim(),
        notification_type: form.notification_type,
        status: "Unread",
      }];
    }

    const { error } = await sb.from("notifications_announcements").insert(rows);
    setSending(false);

    if (error) {
      setMessage({ type: "err", text: error.message });
      return;
    }

    const target = recipientMode === "all"
      ? `all ${rows.length} student(s)`
      : `${recipientName?.last_name || ""}, ${recipientName?.given_name || "student"}`;
    setMessage({ type: "ok", text: `Notification sent to ${target}.` });
    toast.success(`Notification sent to ${target}.`);
    setForm({ student_id: "", title: "", message: "", notification_type: "Announcement" });
    refreshNotifications();
  }

  function exportCsv() {
    downloadCsv("sent-notifications.csv", notifications.map((n) => ({
      notification_id: n.notification_id,
      student: n.student_accounts ? `${n.student_accounts.last_name || ""}, ${n.student_accounts.given_name || ""}` : "All students",
      student_number: n.student_accounts?.student_number || "All students",
      title: n.title,
      message: n.message,
      notification_type: n.notification_type,
      status: n.status ?? "Unread",
      date_sent: formatDateTime(n.date_sent),
    })));
    setMessage({ type: "ok", text: `Exported ${notifications.length} notification(s) as CSV.` });
    toast.success(`Exported ${notifications.length} notification(s) as CSV.`);
  }

  async function deleteNotification(id: number) {
    setMessage(null);
    const sb = getSupabase();
    const { error } = await sb
      .from("notifications_announcements")
      .delete()
      .eq("notification_id", id);
    if (error) {
      setMessage({ type: "err", text: error.message });
      return;
    }
    setNotifications((prev) => prev.filter((n) => n.notification_id !== id));
    setMessage({ type: "ok", text: "Notification deleted." });
    toast.success("Notification deleted.");
  }

  const totalPages = Math.max(1, Math.ceil(notifications.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageItems = notifications.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  if (loading) return <Spinner label="Loading notifications..." color="maroon" />;

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-bold text-[#241012]">Notifications</h1>
          <p className="mt-1 text-xs text-[#8B7376]">{students.length} student(s) registered &middot; {notifications.length} notification(s) sent.</p>
        </div>
        <button
          onClick={exportCsv}
          disabled={!notifications.length}
          className="self-start rounded-xl border border-[#7B1113]/30 px-4 py-2.5 text-xs font-bold text-[#7B1113] transition hover:bg-[#7B1113]/5 disabled:opacity-40"
        >
          &#11015; Export CSV
        </button>
      </div>

      {message && (
        <div className={`rounded-xl border px-4 py-3 text-xs font-medium ${message.type === "ok" ? "border-green-200 bg-green-50 text-green-700" : "border-red-200 bg-red-50 text-red-700"}`}>
          {message.text}
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="rounded-xl border border-[#241012]/[0.06] bg-white p-5 shadow-sm">
          <h2 className="text-sm font-bold text-[#241012]">Send a Notification</h2>
          <p className="mt-1 text-xs text-[#8B7376]">Notify all students at once, or choose one student.</p>

          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => setRecipientMode("all")}
              className={`rounded-xl px-4 py-2 text-xs font-bold transition ${recipientMode === "all" ? "bg-[#7B1113] text-white" : "border border-[#241012]/[0.06] text-[#6B5458] hover:bg-[#7B1113]/5"}`}
            >
              All students ({students.length})
            </button>
            <button
              type="button"
              onClick={() => setRecipientMode("student")}
              className={`rounded-xl px-4 py-2 text-xs font-bold transition ${recipientMode === "student" ? "bg-[#7B1113] text-white" : "border border-[#241012]/[0.06] text-[#6B5458] hover:bg-[#7B1113]/5"}`}
            >
              A specific student
            </button>
          </div>

          <form onSubmit={handleSend} className="mt-4 space-y-4">
            {recipientMode === "student" && (
              <label className="block text-xs font-semibold text-[#241012]">
                Recipient (Student)
                <select
                  value={form.student_id}
                  onChange={(e) => setForm({ ...form, student_id: e.target.value })}
                  required
                  className="mt-1.5 w-full rounded-xl border border-[#241012]/10 bg-white px-3.5 py-2.5 text-xs outline-none transition focus:border-[#7B1113] focus:ring-4 focus:ring-[#7B1113]/10"
                >
                  <option value="">Select a student...</option>
                  {students.map((s) => (
                    <option key={s.student_id} value={s.student_id}>
                      {s.last_name}, {s.given_name} ({s.student_number})
                    </option>
                  ))}
                </select>
              </label>
            )}

            <label className="block text-xs font-semibold text-[#241012]">
              Title
              <input
                type="text"
                value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
                required
                className="mt-1.5 w-full rounded-xl border border-[#241012]/10 bg-white px-3.5 py-2.5 text-xs outline-none transition focus:border-[#7B1113] focus:ring-4 focus:ring-[#7B1113]/10"
                placeholder="Short and clear title"
              />
            </label>

            <label className="block text-xs font-semibold text-[#241012]">
              Message
              <textarea
                value={form.message}
                onChange={(e) => setForm({ ...form, message: e.target.value })}
                required
                rows={4}
                className="mt-1.5 w-full rounded-xl border border-[#241012]/10 bg-white px-3.5 py-2.5 text-xs outline-none transition focus:border-[#7B1113] focus:ring-4 focus:ring-[#7B1113]/10"
                placeholder="Write a friendly, clear update for the student(s)..."
              />
            </label>

            <label className="block text-xs font-semibold text-[#241012]">
              Type
              <select
                value={form.notification_type}
                onChange={(e) => setForm({ ...form, notification_type: e.target.value })}
                className="mt-1.5 w-full rounded-xl border border-[#241012]/10 bg-white px-3.5 py-2.5 text-xs outline-none transition focus:border-[#7B1113] focus:ring-4 focus:ring-[#7B1113]/10"
              >
                {NOTIFICATION_TYPES.map((t) => <option key={t}>{t}</option>)}
              </select>
            </label>

            <button
              type="submit"
              disabled={sending}
              className="w-full rounded-xl bg-gradient-to-r from-[#7B1113] to-[#540111] px-4 py-3 text-sm font-bold text-white shadow-md transition hover:brightness-110 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {sending ? "Sending..." : recipientMode === "all" ? `Send to All Students (${students.length})` : "Send Notification"}
            </button>
          </form>
        </div>

        <div className="rounded-xl border border-[#241012]/[0.06] bg-white p-5 shadow-sm">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-bold text-[#241012]">Sent Notifications</h2>
            <span className="rounded-full bg-[#7B1113]/10 px-2.5 py-1 text-[10px] font-bold text-[#7B1113]">{notifications.length}</span>
          </div>

          {notifications.length === 0 ? (
            <div className="mt-4">
              <EmptyState icon="&#128276;" title="No notifications sent yet" hint="Your sent notifications will appear here." />
            </div>
          ) : (
            <>
              <ul className="mt-4 max-h-[28rem] space-y-3 overflow-y-auto pr-1">
                {pageItems.map((n) => (
                  <li key={n.notification_id} className="rounded-xl border border-[#241012]/[0.06] bg-[#FAF7F5]/50 p-3.5">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="text-xs font-bold text-[#241012]">{n.title}</p>
                          <Badge className={NOTIFICATION_TYPE_STYLES[n.notification_type] || ""}>
                            {n.notification_type}
                          </Badge>
                        </div>
                        <p className="mt-1 text-[11px] text-[#6B5458]">
                          To: {n.student_accounts ? `${n.student_accounts.last_name}, ${n.student_accounts.given_name}` : "All students"}
                        </p>
                        <p className="mt-1 text-[11px] leading-relaxed text-[#8B7376]">{n.message}</p>
                      </div>
                      <div className="flex shrink-0 flex-col items-end gap-1">
                        <span className="text-[10px] text-[#8B7376]">{formatDateTime(n.date_sent)}</span>
                        <button
                          onClick={() => deleteNotification(n.notification_id)}
                          className="rounded-lg border border-red-200 px-2 py-1 text-[10px] font-bold text-red-600 transition hover:bg-red-50"
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
              <div className="mt-3 flex items-center justify-between gap-3 border-t border-[#241012]/[0.06] pt-3 text-[11px]">
                <p className="text-[#8B7376]">Showing {pageItems.length} of {notifications.length}</p>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    disabled={safePage <= 1}
                    className="rounded-lg border border-[#241012]/[0.06] px-2.5 py-1 font-semibold text-[#6B5458] hover:bg-[#FAF7F5] disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    &larr; Prev
                  </button>
                  <span className="font-semibold text-[#7B1113]">{safePage} / {totalPages}</span>
                  <button
                    onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                    disabled={safePage >= totalPages}
                    className="rounded-lg border border-[#241012]/[0.06] px-2.5 py-1 font-semibold text-[#6B5458] hover:bg-[#FAF7F5] disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Next &rarr;
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
