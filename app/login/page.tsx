/**
 * Mode A login. The password is checked in a Server Action (never in the browser bundle)
 * and the cookie stores a hash of it, not the password.
 */
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { COOKIE, sessionToken } from "@/proxy";

export const metadata = { title: "Sign in — trysearch" };

async function signIn(formData: FormData) {
  "use server";

  const password = process.env.CONSOLE_PASSWORD;
  const submitted = String(formData.get("password") ?? "");
  const next = String(formData.get("next") ?? "/dashboard") || "/dashboard";

  if (!password || submitted !== password) {
    redirect(`/login?error=1&next=${encodeURIComponent(next)}`);
  }

  const jar = await cookies();
  jar.set(COOKIE, sessionToken(password), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });

  // Only ever redirect to an in-app path, so a crafted ?next= cannot bounce a signed-in
  // session off to another origin.
  redirect(next.startsWith("/") && !next.startsWith("//") ? next : "/dashboard");
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; next?: string }>;
}) {
  const { error, next } = await searchParams;

  return (
    <main className="flex min-h-dvh items-center justify-center p-6">
      <div className="panel w-full max-w-sm p-6">
        <h1 className="text-lg font-semibold">trysearch</h1>
        <p className="mt-1 text-[13px] text-[var(--fg-muted)]">
          App Store Optimization console. Enter the shared password to continue.
        </p>

        <form action={signIn} className="mt-5 space-y-3">
          <input type="hidden" name="next" value={next ?? "/dashboard"} />
          <div>
            <label htmlFor="password" className="th block mb-1.5">
              Password
            </label>
            <input
              id="password"
              name="password"
              type="password"
              autoFocus
              autoComplete="current-password"
              className="w-full rounded-[var(--radius-chip)] border border-[var(--border)] bg-[var(--bg-elevated)] px-3 py-2 text-[var(--fg)] placeholder:text-[var(--fg-subtle)]"
              placeholder="••••••••"
            />
          </div>

          {error ? (
            <p role="alert" className="text-[13px] text-[var(--down)]">
              That password is not right.
            </p>
          ) : null}

          <button
            type="submit"
            className="w-full rounded-[var(--radius-chip)] bg-[var(--accent)] px-3 py-2 font-medium text-white hover:opacity-90"
          >
            Sign in
          </button>
        </form>

        <p className="mt-4 text-[12px] text-[var(--fg-subtle)]">
          All data here comes from free public App Store and Google Play endpoints.
        </p>
      </div>
    </main>
  );
}
