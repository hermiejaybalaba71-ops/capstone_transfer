"use client";

import { createClient } from "@supabase/supabase-js";
import { useState, useEffect } from "react";
import type { Session, User } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

function requireSupabaseConfig() {
  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error("Supabase is not configured. Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY, then restart the app.");
  }
  return { url: supabaseUrl, anonKey: supabaseAnonKey };
}

function getCookieName() {
  const { url } = requireSupabaseConfig();
  const match = url.match(/https?:\/\/([^.]+)/);
  return `sb-${match ? match[1] : "xflsxzmniseetvkrddmj"}-auth-token`;
}

function cookieStorage() {
  return {
    getItem: (key: string) => {
      const v = document.cookie.split("; ").find((c) => c.startsWith(key + "="));
      return v ? decodeURIComponent(v.split("=").slice(1).join("=")) : null;
    },
    setItem: (key: string, value: string) => {
      document.cookie = `${key}=${encodeURIComponent(value)}; path=/; max-age=31536000; SameSite=Lax`;
    },
    removeItem: (key: string) => {
      document.cookie = `${key}=; path=/; max-age=0`;
    },
  };
}

export function getBrowserClient() {
  const { url, anonKey } = requireSupabaseConfig();
  return createClient(url, anonKey, {
    auth: {
      persistSession: true,
      storage: cookieStorage(),
      storageKey: getCookieName(),
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  });
}

let browserClient: ReturnType<typeof getBrowserClient> | null = null;

export function getSupabase() {
  if (!browserClient) {
    browserClient = getBrowserClient();
  }
  return browserClient;
}

export function useSession() {
  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const sb = getSupabase();
    sb.auth.getSession().then(({ data: { session: s } }) => {
      setSession(s);
      setUser(s?.user ?? null);
      setLoading(false);
    });

    const { data: { subscription } } = sb.auth.onAuthStateChange((_event, s) => {
      setSession(s);
      setUser(s?.user ?? null);
      setLoading(false);
    });

    return () => subscription.unsubscribe();
  }, []);

  return { session, user, loading };
}
