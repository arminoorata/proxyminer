/**
 * Review login. Submits the admin token; the action route signs a
 * cookie scoped to /review.
 */
export default async function ReviewLoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const error = typeof params.error === "string" ? params.error : "";

  return (
    <main className="mx-auto max-w-md px-6 py-16 md:px-10">
      <p
        className="text-xs font-medium uppercase tracking-[0.32em]"
        style={{ color: "var(--accent)" }}
      >
        ProxyMiner / Review
      </p>
      <h1 className="mt-4 text-2xl font-semibold">Reviewer sign-in</h1>
      <p className="mt-3 text-sm" style={{ color: "var(--muted)" }}>
        Internal QA only. Use the admin token from the project env.
      </p>
      {error ? (
        <p
          className="mt-4 rounded border px-3 py-2 text-sm"
          style={{ borderColor: "var(--line)", color: "var(--negative)" }}
        >
          {error}
        </p>
      ) : null}
      <form
        action="/review/session"
        method="post"
        className="mt-6 flex flex-col gap-3 rounded-lg border p-5"
        style={{ borderColor: "var(--line)", background: "var(--surface)" }}
      >
        <label className="flex flex-col gap-1.5 text-sm">
          <span className="text-[11px] uppercase tracking-[0.18em]" style={{ color: "var(--accent)" }}>
            Admin token
          </span>
          <input
            type="password"
            name="token"
            required
            autoComplete="off"
            className="rounded-md border bg-transparent px-3 py-2 text-sm outline-none focus:border-accent"
            style={{ borderColor: "var(--line)", color: "var(--text)" }}
          />
        </label>
        <button type="submit" className="btn btn-primary">Sign in</button>
      </form>
    </main>
  );
}
