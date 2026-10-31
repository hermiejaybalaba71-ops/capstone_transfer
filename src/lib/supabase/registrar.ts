import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const registrarUrl = process.env.NEXT_PUBLIC_REGISTRAR_SUPABASE_URL;
const registrarKey = process.env.NEXT_PUBLIC_REGISTRAR_SUPABASE_ANON_KEY;
const mainUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const mainKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

export function createRegistrarClient(): SupabaseClient {
  if (registrarUrl && registrarKey) {
    return createClient(registrarUrl, registrarKey);
  }
  if (!mainUrl || !mainKey) {
    throw new Error("Supabase is not configured for registrar lookups.");
  }
  return createClient(mainUrl, mainKey);
}

export function getRegistrarSupabase(): SupabaseClient {
  return createRegistrarClient();
}

/** Fallback client (main project) when the dedicated registrar project is unreachable. */
export function getRegistrarFallback(): SupabaseClient | null {
  if (!mainUrl || !mainKey) return null;
  if (registrarUrl && mainUrl && registrarUrl === mainUrl) return null;
  return createClient(mainUrl, mainKey);
}

/**
 * Run a registrar query against the dedicated registrar project first,
 * then automatically fall back to the main project (where registrar_* tables
 * can also be installed) when the registrar project is unreachable.
 */
export async function queryRegistrar<T>(
  run: (client: SupabaseClient) => PromiseLike<{ data: T | null; error: { message: string } | null }>
): Promise<{ data: T | null; error: { message: string } | null; usedFallback: boolean }> {
  try {
    const res = await run(getRegistrarSupabase());
    if (!res.error) return { ...res, usedFallback: false };
  } catch {
    // network / DNS failure — fall through
  }
  const fallback = getRegistrarFallback();
  if (fallback) {
    try {
      const res = await run(fallback);
      return { ...res, usedFallback: true };
    } catch (e) {
      return { data: null, error: { message: e instanceof Error ? e.message : "Failed to fetch" }, usedFallback: true };
    }
  }
  return { data: null, error: { message: "Registrar database is unreachable." }, usedFallback: false };
}

export const registrarSupabase = (() => {
  try {
    return createRegistrarClient();
  } catch {
    return null as unknown as SupabaseClient;
  }
})();
