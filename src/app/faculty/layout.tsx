"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getSupabase } from "@/lib/supabase/browser";
import { Sidebar, type SidebarItem, type NotificationItem } from "@/components/layout/sidebar";

const MENU_ITEMS: SidebarItem[] = [
  { label: "Dashboard", href: "/faculty", icon: "🏠", processFn: "1.0" },
  { label: "Early Warning Alerts Detection", href: "/faculty/alerts", icon: "⚠️", processFn: "2.0" },
  { label: "Intervention to Students", href: "/faculty/interventions", icon: "💬", processFn: "3.0" },
  { label: "Scholarships Approval List", href: "/faculty/approvals", icon: "🏆", processFn: "4.0" },
];

export default function FacultyLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [username, setUsername] = useState("Faculty");
  const [notifCount, setNotifCount] = useState(0);
  useEffect(() => {
    const sb = getSupabase();
    sb.auth.getSession().then(async ({ data: { session } }) => {
      if (!session) { router.push("/login"); return; }
      const { data: rows } = await sb.from("users").select("username, role").eq("auth_user_id", session.user.id);
      const row = (rows || []).find((u) => u.role !== "Student") || rows?.[0];
      if (!row) { router.push("/login"); return; }
      if (row.username) setUsername(row.username);
      if (row.role !== "Faculty") {
        const home = row.role === "Admin" ? "/admin" : row.role === "CHED" ? "/ched" : "/student";
        router.replace(home);
        return;
      }
      sb.from("early_warning_alerts").select("warning_id", { count: "exact", head: true }).eq("status", "Active").then(({ count }) => { setNotifCount(count ?? 0); });
    });
  }, [router]);
  const handleLogout = async () => { await getSupabase().auth.signOut(); router.push("/login"); };

  // Facebook-style bell: recent Active alerts; clicking marks the alert "Resolved".
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
      <Sidebar items={MENU_ITEMS} title="St. Peter's College" subtitle="Faculty Monitoring Console" username={username} userRole="Faculty" onLogout={handleLogout} notificationCount={notifCount} notificationHref="/faculty/alerts" fetchNotifications={fetchNotifications} onNotificationClick={onNotificationClick} />
      <main className="min-h-screen p-4 pt-16 lg:ml-64 lg:p-8 lg:pt-6">{children}</main>
    </div>
  );
}
