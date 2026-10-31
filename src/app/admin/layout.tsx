"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getSupabase } from "@/lib/supabase/browser";
import { Sidebar, type SidebarItem, type NotificationItem } from "@/components/layout/sidebar";

const MENU_ITEMS: SidebarItem[] = [
  { label: "Dashboard", href: "/admin", icon: "🏠", processFn: "1.0" },
  { label: "Create Account", href: "/admin/create-account", icon: "➕", processFn: "2.0" },
  { label: "User Management", href: "/admin/users", icon: "👥", processFn: "3.0" },
  { label: "Manage Scholarship Programs", href: "/admin/programs", icon: "📋", processFn: "4.0" },
  { label: "Scholarship Applications", href: "/admin/applications", icon: "📄", processFn: "5.0" },
  { label: "Machine Learning Ranking", href: "/admin/ranking", icon: "🤖", processFn: "6.0" },
  { label: "Approvals / Validate", href: "/admin/approvals", icon: "✅", processFn: "7.0" },
  { label: "Notifications and Announcement", href: "/admin/notifications", icon: "🔔", processFn: "8.0" },
  { label: "Documents Viewer", href: "/admin/documents", icon: "📁" },
];

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [username, setUsername] = useState("Admin");
  const [notifCount, setNotifCount] = useState(0);
  useEffect(() => {
    const sb = getSupabase();
    sb.auth.getSession().then(async ({ data: { session } }) => {
      if (!session) { router.push("/login"); return; }
      const { data: rows } = await sb.from("users").select("username, role").eq("auth_user_id", session.user.id);
      const row = (rows || []).find((u) => u.role !== "Student") || rows?.[0];
      if (!row) { router.push("/login"); return; }
      if (row.username) setUsername(row.username);
      if (row.role !== "Admin") {
        const home = row.role === "CHED" ? "/ched" : row.role === "Faculty" ? "/faculty" : "/student";
        router.replace(home);
        return;
      }
      sb.from("early_warning_alerts").select("warning_id", { count: "exact", head: true }).eq("status", "Active").then(({ count }) => { setNotifCount(count ?? 0); });
    });
  }, [router]);
  const handleLogout = async () => { await getSupabase().auth.signOut(); router.push("/login"); };

  // Facebook-style bell: recent Active alerts; clicking marks the alert "Resolved"
  // so it disappears from the popup and the badge count drops immediately.
  async function fetchNotifications() {
    const sb = getSupabase();
    const { data } = await sb
      .from("early_warning_alerts")
      .select("warning_id, warning_message, warning_date, student_accounts(last_name, given_name)")
      .eq("status", "Active")
      .order("warning_date", { ascending: false })
      .limit(15);
    const rows = (data || []) as unknown as Array<{
      warning_id: number;
      warning_message: string;
      warning_date: string;
      student_accounts: { last_name?: string; given_name?: string } | null;
    }>;
    return rows.map((a) => ({
      id: String(a.warning_id),
      title: `${a.student_accounts?.last_name ?? ""}, ${a.student_accounts?.given_name ?? ""}`,
      message: a.warning_message,
      meta: (a.warning_date || "").slice(0, 10),
      unread: true,
    }));
  }
  async function onNotificationClick(n: NotificationItem) {
    const sb = getSupabase();
    await sb.from("early_warning_alerts").update({ status: "Resolved" }).eq("warning_id", Number(n.id));
  }
  return (
    <div className="min-h-screen bg-[#FAF7F5]">
      <Sidebar items={MENU_ITEMS} title="St. Peter's College" subtitle="Administrator Console" username={username} userRole="Administrator" onLogout={handleLogout} notificationCount={notifCount} notificationHref="/admin/notifications" fetchNotifications={fetchNotifications} onNotificationClick={onNotificationClick} />
      <main className="min-h-screen p-4 pt-16 lg:ml-64 lg:p-8 lg:pt-6">{children}</main>
    </div>
  );
}
