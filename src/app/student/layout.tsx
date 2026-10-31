"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getSupabase } from "@/lib/supabase/browser";
import { Sidebar, type SidebarItem, type NotificationItem } from "@/components/layout/sidebar";

const MENU_ITEMS: SidebarItem[] = [
  { label: "Dashboard", href: "/student", icon: "🏠", processFn: "2.0" },
  { label: "View Available Scholarship Programs", href: "/student/programs", icon: "📋", processFn: "3.0" },
  { label: "Submit / Apply Scholarships", href: "/student/apply", icon: "📝", processFn: "4.0" },
  { label: "Scholarships Status in Dashboard", href: "/student/status", icon: "📈", processFn: "5.0" },
  { label: "Received Notifications and Announcement", href: "/student/notifications", icon: "🔔", processFn: "6.0" },
  { label: "Early Warning Alerts Detection", href: "/student/alerts", icon: "⚠️", processFn: "7.0" },
  { label: "Profile & Documents", href: "/student/profile", icon: "👤" },
];

export default function StudentLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [username, setUsername] = useState("Student");
  const [notifCount, setNotifCount] = useState(0);
  useEffect(() => {
    const sb = getSupabase();
    sb.auth.getSession().then(async ({ data: { session } }) => {
      if (!session) { router.push("/login"); return; }
      const { data: rows } = await sb.from("users").select("username, role").eq("auth_user_id", session.user.id);
      const row = (rows || []).find((u) => u.role !== "Student") || rows?.[0];
      if (!row) { router.push("/login"); return; }
      if (row.username) setUsername(row.username);
      if (row.role && row.role !== "Student") {
        const home = row.role === "Admin" ? "/admin" : row.role === "CHED" ? "/ched" : "/faculty";
        router.replace(home);
        return;
      }
      sb.from("users").select("user_id").eq("auth_user_id", session.user.id).maybeSingle().then(({ data: userRow }) => {
        if (!userRow) return;
        sb.from("student_accounts").select("student_id").eq("user_id", userRow.user_id).maybeSingle().then(({ data: sa }) => {
          if (!sa) return;
          sb.from("notifications_announcements").select("notification_id", { count: "exact", head: true }).eq("student_id", sa.student_id).eq("status", "Unread").then(({ count }) => { setNotifCount(count ?? 0); });
        });
      });
    });
  }, [router]);
  const handleLogout = async () => { await getSupabase().auth.signOut(); router.push("/login"); };

  // Facebook-style bell: the student's recent notifications; clicking one marks
  // it "Read" so it disappears from the popup and the unread badge drops.
  async function fetchNotifications() {
    const sb = getSupabase();
    const { data: userRow } = await sb.from("users").select("user_id").eq("auth_user_id", (await sb.auth.getSession()).data.session?.user?.id || "").maybeSingle();
    if (!userRow) return [];
    const { data: sa } = await sb.from("student_accounts").select("student_id").eq("user_id", userRow.user_id).maybeSingle();
    if (!sa) return [];
    const { data } = await sb
      .from("notifications_announcements")
      .select("notification_id, title, message, date_sent, status")
      .eq("student_id", sa.student_id)
      .order("date_sent", { ascending: false })
      .limit(15);
    return (data || []).map((n) => ({
      id: String(n.notification_id),
      title: n.title,
      message: n.message,
      meta: (n.date_sent || "").slice(0, 10),
      unread: n.status !== "Read",
    }));
  }
  async function onNotificationClick(n: NotificationItem) {
    const sb = getSupabase();
    await sb.from("notifications_announcements").update({ status: "Read" }).eq("notification_id", Number(n.id));
  }
  return (
    <div className="min-h-screen bg-[#FAF7F5]">
      <Sidebar items={MENU_ITEMS} title="St. Peter's College" subtitle="Student Portal" username={username} userRole="Student" onLogout={handleLogout} notificationCount={notifCount} notificationHref="/student/notifications" fetchNotifications={fetchNotifications} onNotificationClick={onNotificationClick} />
      <main className="min-h-screen p-4 pt-16 lg:ml-64 lg:p-8 lg:pt-6">{children}</main>
    </div>
  );
}
