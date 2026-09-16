import { cookies } from "next/headers";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { SESSION_COOKIE_NAME, validateSessionToken } from "@/lib/auth/session";
import { signOut } from "@/lib/auth/actions";

export default async function Home() {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  const session = token ? await validateSessionToken(token) : null;

  let email: string | null = null;
  if (session) {
    const [user] = await db
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, session.userId))
      .limit(1);
    email = user?.email ?? null;
  }

  return (
    <main style={{ padding: "2rem", fontFamily: "system-ui, sans-serif" }}>
      <h1>Academy Management SaaS</h1>
      <p>Phase 0, Items 1-16. No further application features yet.</p>
      {email ? (
        <>
          <p>Signed in as {email}.</p>
          <p>
            <a href="/account/security">Account security</a>
          </p>
          <form action={signOut}>
            <button type="submit">Sign out</button>
          </form>
        </>
      ) : (
        <p>
          <a href="/login">Sign in</a>
        </p>
      )}
    </main>
  );
}
