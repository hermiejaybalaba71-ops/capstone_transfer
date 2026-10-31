"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

const ROLES = [
  { label: "Students", href: "/student", icon: "🎓", desc: "Apply online, upload documents, and track your status." },
  { label: "Administrators", href: "/admin", icon: "⚙️", desc: "Manage programs, applications, and run the ML ranking." },
  { label: "Faculty", href: "/faculty", icon: "👨‍🏫", desc: "Monitor scholars and intervene before grades slip." },
  { label: "CHED", href: "/ched", icon: "🏛️", desc: "Review the ranked list and approve beneficiaries." },
];

const STEPS = [
  { num: "01", title: "Register & Verify", desc: "Records validated against the Registrar system." },
  { num: "02", title: "Apply", desc: "Submit the CHED form, ITR, and supporting documents." },
  { num: "03", title: "ML Ranking", desc: "Random Forest ranks applicants by family income." },
  { num: "04", title: "Approve", desc: "CHED reviews the ranked list and approves scholars." },
  { num: "05", title: "Monitor", desc: "Grades below 93% trigger an early-warning alert." },
];

type Stats = { programs: number; applications: number; scholars: number; students: number };

const STAT_META: { key: keyof Stats; label: string }[] = [
  { key: "programs", label: "Open Programs" },
  { key: "applications", label: "Applications" },
  { key: "scholars", label: "Scholars Approved" },
  { key: "students", label: "Registered Students" },
];

function LiveStats() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [updated, setUpdated] = useState<string>("");

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch("/api/home/stats", { cache: "no-store" });
        if (!res.ok) return;
        const json = await res.json();
        if (alive && json.ok && json.stats) {
          setStats(json.stats);
          setUpdated(new Date().toLocaleTimeString("en-PH", { hour: "2-digit", minute: "2-digit", second: "2-digit" }));
        }
      } catch {
        /* keep last known values */
      }
    };
    load();
    const id = setInterval(load, 30000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  return (
    <div className="mx-auto mt-12 max-w-3xl">
      <div className="mb-3 flex items-center justify-center gap-2 text-xs text-white/60">
        <span className="relative flex h-2 w-2">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-400" />
        </span>
        Live system{updated ? ` · updated ${updated}` : ""}
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {STAT_META.map(({ key, label }) => (
          <div key={key} className="rounded-xl border border-white/10 bg-white/5 px-4 py-4 backdrop-blur">
            <p className="text-2xl font-bold sm:text-3xl">
              {stats ? stats[key] : <span className="text-white/30">&ndash;</span>}
            </p>
            <p className="mt-1 text-[11px] uppercase tracking-wide text-white/50">{label}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function LandingPage() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const scrollTo = (id: string) => {
    setMobileOpen(false);
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth" });
  };

  const navItems = ["How It Works", "Roles"];

  return (
    <div className="min-h-screen bg-[#0f0506] font-sans text-white antialiased selection:bg-[#7B1113]/50">
      {/* NAVBAR */}
      <header className={`fixed top-0 z-50 w-full border-b transition-colors ${scrolled ? "border-white/10 bg-[#0f0506]/90 backdrop-blur-xl" : "border-transparent bg-transparent"}`}>
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6">
          <Link href="/" className="flex items-center gap-2.5">
            <img src="/logo.jpg" alt="St. Peter's College logo" className="h-8 w-8 rounded-lg bg-white object-contain shadow" />
            <span className="text-sm font-semibold">Scholarship System</span>
          </Link>
          <nav className="hidden items-center gap-1 md:flex">
            {navItems.map((item) => (
              <button key={item} onClick={() => scrollTo(item.toLowerCase().replace(/ /g, "-"))} className="rounded-lg px-3 py-2 text-sm text-white/60 transition hover:bg-white/5 hover:text-white">
                {item}
              </button>
            ))}
          </nav>
          <div className="flex items-center gap-2">
            <Link href="/login" className="hidden rounded-lg px-4 py-2 text-sm font-medium text-white/80 transition hover:text-white sm:block">Log in</Link>
            <Link href="/register" className="rounded-lg bg-gradient-to-r from-[#7B1113] to-[#540111] px-4 py-2 text-sm font-semibold text-white transition hover:brightness-110">Register</Link>
            <button onClick={() => setMobileOpen(!mobileOpen)} className="flex h-9 w-9 items-center justify-center rounded-lg text-white/60 transition hover:bg-white/10 md:hidden">
              {mobileOpen ? "✕" : "☰"}
            </button>
          </div>
        </div>
        {mobileOpen && (
          <div className="border-t border-white/10 bg-[#0f0506]/95 backdrop-blur-xl md:hidden">
            <div className="space-y-1 px-4 py-4">
              {navItems.map((item) => (
                <button key={item} onClick={() => scrollTo(item.toLowerCase().replace(/ /g, "-"))} className="block w-full rounded-lg px-4 py-3 text-left text-sm text-white/70 transition hover:bg-white/5 hover:text-white">
                  {item}
                </button>
              ))}
              <div className="mt-3 grid grid-cols-2 gap-2 border-t border-white/10 pt-4">
                <Link href="/login" className="rounded-lg border border-white/15 px-4 py-3 text-center text-sm font-semibold text-white transition hover:bg-white/5">Log in</Link>
                <Link href="/register" className="rounded-lg bg-gradient-to-r from-[#7B1113] to-[#540111] px-4 py-3 text-center text-sm font-semibold text-white transition hover:brightness-110">Register</Link>
              </div>
            </div>
          </div>
        )}
      </header>

      {/* HERO */}
      <section className="relative overflow-hidden bg-gradient-to-b from-[#7B1113] via-[#5A0C0E] to-[#3E0009] px-4 pb-20 pt-36 text-center sm:pt-40">
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_80%_50%_at_50%_-20%,rgba(255,255,255,0.12),transparent)]" />
        <div className="relative mx-auto max-w-3xl">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-white/60">St. Peter&rsquo;s College, Iligan City</p>
          <h1 className="mt-4 text-3xl font-bold leading-tight tracking-tight sm:text-4xl lg:text-5xl">
            Intelligent Scholarship Application, Ranking, and Early-Warning Monitoring System for HEIs
          </h1>
          <p className="mx-auto mt-5 max-w-2xl text-base leading-relaxed text-white/70">
            A unified scholarship platform for higher education institutions: students apply online,
            documents and ITR income are verified, machine learning ranks applicants by financial
            need, CHED reviews and approves scholars, administrators validate the final list, and
            faculty receive early-warning alerts when academic performance needs attention.
          </p>
          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Link href="/register" className="rounded-xl bg-white px-7 py-3.5 text-sm font-semibold text-[#7B1113] transition hover:bg-white/90">
              Start Your Application
            </Link>
            <button onClick={() => scrollTo("how-it-works")} className="rounded-xl border border-white/25 px-7 py-3.5 text-sm font-medium text-white/80 transition hover:border-white/50 hover:text-white">
              See How It Works &darr;
            </button>
          </div>
          <LiveStats />
        </div>
      </section>

      {/* HOW IT WORKS */}
      <section id="how-it-works" className="scroll-mt-20 px-4 py-20 sm:py-24">
        <div className="mx-auto max-w-6xl">
          <div className="text-center">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-white/50">Process Flow</p>
            <h2 className="mt-3 text-2xl font-bold sm:text-3xl">How it works</h2>
          </div>
          <ol className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
            {STEPS.map((step) => (
              <li key={step.num} className="rounded-2xl border border-white/10 bg-white p-5 text-[#241012]">
                <span className="text-xs font-bold text-[#7B1113]">{step.num}</span>
                <h3 className="mt-2 text-sm font-bold">{step.title}</h3>
                <p className="mt-1.5 text-xs leading-relaxed text-[#6B5458]">{step.desc}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* ROLES */}
      <section id="roles" className="scroll-mt-20 bg-white px-4 py-20 sm:py-24">
        <div className="mx-auto max-w-6xl">
          <div className="text-center">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[#7B1113]">Four Roles</p>
            <h2 className="mt-3 text-2xl font-bold text-[#241012] sm:text-3xl">One unified system</h2>
          </div>
          <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {ROLES.map((role) => (
              <Link key={role.label} href={role.href} className="group rounded-2xl border border-[#241012]/[0.06] bg-[#FAF7F5] p-6 transition hover:-translate-y-1 hover:border-[#7B1113]/25 hover:shadow-[0_18px_40px_-15px_rgba(123,17,19,0.25)]">
                <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br from-[#7B1113] to-[#540111] text-2xl shadow-lg">{role.icon}</span>
                <h3 className="mt-4 text-lg font-bold text-[#241012]">{role.label}</h3>
                <p className="mt-2 text-sm leading-relaxed text-[#6B5458]">{role.desc}</p>
                <span className="mt-4 inline-block text-xs font-medium text-[#7B1113] opacity-0 transition group-hover:opacity-100">
                  Open dashboard &rarr;
                </span>
              </Link>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="px-4 py-20">
        <div className="mx-auto max-w-3xl rounded-3xl bg-gradient-to-br from-[#7B1113] via-[#5A0C0E] to-[#3E0009] p-10 text-center shadow-[0_25px_60px_-20px_rgba(123,17,19,0.5)] sm:p-14">
          <h2 className="text-2xl font-bold sm:text-3xl">Ready to apply?</h2>
          <p className="mx-auto mt-3 max-w-md text-sm text-white/70">Create your account and start your scholarship application today.</p>
          <div className="mt-7 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Link href="/register" className="rounded-xl bg-white px-7 py-3.5 text-sm font-semibold text-[#7B1113] transition hover:bg-white/90">Create Account</Link>
            <Link href="/login" className="rounded-xl border border-white/25 px-7 py-3.5 text-sm font-medium text-white/80 transition hover:border-white/50 hover:text-white">Log In</Link>
          </div>
        </div>
      </section>

      {/* FOOTER */}
      <footer className="border-t border-white/10 py-8">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-3 px-4 text-center text-xs text-white/40 sm:flex-row sm:px-6">
          <span>&copy; {new Date().getFullYear()} St. Peter&rsquo;s College, Iligan City</span>
          <Link href="/terms" className="underline underline-offset-2 transition hover:text-white/70">Terms &amp; Conditions</Link>
        </div>
      </footer>
    </div>
  );
}
