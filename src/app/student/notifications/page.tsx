"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getSupabase } from "@/lib/supabase/browser";
import { formatDateTime } from "@/lib/utils";
import { NOTIFICATION_TYPE_STYLES } from "@/lib/constants";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { Spinner } from "@/components/ui/spinner";

interface Notification {
  notification_id: number;
  student_id: number;
  title: string;
  message: string;
  notification_type: string;
  date_sent: string;
  is_read?: boolean;
  status?: string;
}

export default function NotificationsPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [studentId, setStudentId] = useState<number | null>(null);
  const [markingAll, setMarkingAll] = useState(false);
  const [page, setPage] = useState(1);
  const [reloadKey, setReloadKey] = useState(0);
  const PAGE_SIZE = 10;

  useEffect(() => {
    let ignore = false;
    async function startFetching() {
      const sb = getSupabase();
      const { data: sessionData } = await sb.auth.getSession();
      if (!sessionData.session) {
        router.push("/login");
        return;
      }

      const { data: authUser } = await sb.auth.getUser();

      const userId = authUser.user?.id;
      if (!userId) { setLoading(false); return; }

      const userQuery = await sb
        .from("users")
        .select("user_id")
        .eq("auth_user_id", userId)
        .maybeSingle();

      if (userQuery.error || !userQuery.data) {
        setLoading(false);
        return;
      }

      const accountQuery = await sb
        .from("student_accounts")
        .select("student_id")
        .eq("user_id", userQuery.data.user_id)
        .maybeSingle();

      if (accountQuery.error || !accountQuery.data) {
        setLoading(false);
        return;
      }

      const sid = accountQuery.data.student_id;
      setStudentId(sid);

      const { data, error } = await sb
        .from("notifications_announcements")
        .select("*")
        .eq("student_id", sid)
        .order("date_sent", { ascending: false });

      if (!error && data) {
        setNotifications(data);
      }

      if (!ignore) setLoading(false);
    }
    startFetching();
    return () => { ignore = true; };
  }, [router, reloadKey]);

  // Live-refresh when CHED/admin sends approval or status updates.
  useEffect(() => {
    if (!studentId) return;
    const sb = getSupabase();
    const channel = sb
      .channel(`student-notifs-${studentId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "notifications_announcements", filter: `student_id=eq.${studentId}` },
        () => setReloadKey((k) => k + 1)
      )
      .subscribe();
    const poll = window.setInterval(() => setReloadKey((k) => k + 1), 30000);
    return () => {
      sb.removeChannel(channel);
      window.clearInterval(poll);
    };
  }, [studentId]);

  async function markAllAsRead() {
    if (!studentId) return;
    const unread = notifications.filter((n) => n.status === "Unread");
    if (unread.length === 0) return;

    setMarkingAll(true);
    const sb = getSupabase();

    const ids = unread.map((n) => n.notification_id);
    const { error } = await sb
      .from("notifications_announcements")
      .update({ status: "Read" })
      .eq("student_id", studentId)
      .in("notification_id", ids);

    if (!error) {
      setNotifications((prev) => prev.map((n) => ({ ...n, status: "Read" })));
    }

    setMarkingAll(false);
  }

  async function deleteNotification(id: number) {
    const sb = getSupabase();
    const { error } = await sb
      .from("notifications_announcements")
      .delete()
      .eq("notification_id", id);
    if (error) return;
    setNotifications((prev) => prev.filter((n) => n.notification_id !== id));
  }

  const unreadCount = notifications.filter((n) => n.status === "Unread").length;

  const totalPages = Math.max(1, Math.ceil(notifications.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageItems = notifications.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  if (loading) {
    return <Spinner label="Loading notifications..." />;
  }

  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-[#241012]">Notifications</h1>
          <p className="mt-1 text-xs text-[#6B5458]">Messages and status updates from the scholarship office.</p>
        </div>
        {unreadCount > 0 && (
          <button
            onClick={markAllAsRead}
            disabled={markingAll}
            className="rounded-lg bg-[#7B1113] px-4 py-2.5 text-xs font-bold text-white hover:bg-[#540111] disabled:opacity-60"
          >
            {markingAll ? "Marking\u2026" : `Mark all as read (${unreadCount})`}
          </button>
        )}
      </div>

      {notifications.length === 0 ? (
        <div className="mt-4">
          <EmptyState
            icon="🔔"
            title="No notifications yet"
            hint="You will see updates here when available."
          />
        </div>
      ) : (
        <>
          <div className="mt-4 space-y-3">
            {pageItems.map((n) => (
              <div
                key={n.notification_id}
                className={`rounded-xl border p-5 shadow-sm ${
                  n.status === "Unread"
                    ? "border-[#7B1113]/20 bg-white"
                    : "border-[#241012]/[0.06] bg-[#FAF7F5]"
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      {n.status === "Unread" && (
                        <span className="h-2 w-2 shrink-0 rounded-full bg-[#7B1113]" />
                      )}
                      <p
                        className={`text-xs ${
                          n.status === "Unread"
                            ? "font-bold text-[#241012]"
                            : "text-[#6B5458]"
                        }`}
                      >
                        {n.title}
                      </p>
                    </div>
                    <p className="mt-1 text-xs text-[#6B5458]">{n.message}</p>
                    <p className="mt-1 text-[11px] text-[#8B7376]">
                      {formatDateTime(n.date_sent)}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {n.notification_type && (
                      <Badge className={NOTIFICATION_TYPE_STYLES[n.notification_type] || ""}>
                        {n.notification_type}
                      </Badge>
                    )}
                    <Badge
                      className={
                        n.status === "Unread"
                          ? "border-amber-200 bg-amber-100 text-amber-800"
                          : "border-[#241012]/[0.06] bg-[#F3EEEB] text-[#6B5458]"
                      }
                    >
                      {n.status === "Unread" ? "Unread" : "Read"}
                    </Badge>
                    <button
                      onClick={() => deleteNotification(n.notification_id)}
                      title="Delete this notification"
                      className="rounded-lg border border-red-200 px-2 py-1 text-[10px] font-bold text-red-600 transition hover:bg-red-50"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
          <div className="mt-4 flex items-center justify-between gap-3 text-xs">
            <p className="text-[#6B5458]">
              Showing {Math.min(notifications.length, safePage * PAGE_SIZE) - (safePage - 1) * PAGE_SIZE} of {notifications.length} notification(s)
            </p>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={safePage <= 1}
                className="rounded-lg border border-[#241012]/[0.06] px-3 py-1.5 font-semibold text-[#241012] hover:bg-[#FAF7F5] disabled:cursor-not-allowed disabled:opacity-40"
              >
                &larr; Prev
              </button>
              <span className="font-semibold text-[#7B1113]">{safePage} / {totalPages}</span>
              <button
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={safePage >= totalPages}
                className="rounded-lg border border-[#241012]/[0.06] px-3 py-1.5 font-semibold text-[#241012] hover:bg-[#FAF7F5] disabled:cursor-not-allowed disabled:opacity-40"
              >
                Next &rarr;
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
