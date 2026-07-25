import { createClient } from "@supabase/supabase-js";

/**
 * Vite inlines `import.meta.env.*` at BUILD time, so a variable missing from the
 * build environment becomes an empty string in the bundle — not a runtime lookup
 * that could recover. `createClient` then throws "supabaseKey is required" while
 * this module is still evaluating, which takes down the whole app with a
 * minified stack trace and a blank page.
 *
 * Checking here turns that into a message naming the missing variable and where
 * to set it.
 */
const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

const missing = [
  !url && "VITE_SUPABASE_URL",
  !anonKey && "VITE_SUPABASE_ANON_KEY",
].filter(Boolean);

if (missing.length > 0) {
  throw new Error(
    `Missing build-time environment ${missing.length > 1 ? "variables" : "variable"}: ` +
      `${missing.join(", ")}. These are baked into the bundle when it is built, so set ` +
      `them in the build environment (locally: web/.env — on Netlify: Site ` +
      `configuration → Environment variables) and rebuild. Redeploying the same ` +
      `bundle will not pick them up.`,
  );
}

export const supabase = createClient(url, anonKey);
