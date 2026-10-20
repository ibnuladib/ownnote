import { expect, type APIRequestContext, type Page } from "@playwright/test";

declare const process: { env: Record<string, string | undefined> }; // root tsconfig has no node types

export const PASSWORD = process.env.E2E_PASSWORD ?? "testpass";
export const YT_URL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
export const YT_ID = "dQw4w9WgXcQ";

/** Log in through the API (cookie lands in the shared browser/request context). */
export async function apiLogin(request: APIRequestContext): Promise<void> {
  const res = await request.post("/api/login", { data: { password: PASSWORD } });
  expect(res.status(), "login with correct password").toBe(204);
}

/** Delete every note (cascades videos/tags) so each test starts from an empty notebook. */
export async function resetNotes(request: APIRequestContext): Promise<void> {
  const res = await request.get("/api/notes");
  expect(res.status()).toBe(200);
  const { notes } = (await res.json()) as { notes: { id: string }[] };
  for (const n of notes) {
    const d = await request.delete(`/api/notes/${n.id}`);
    expect([204, 404]).toContain(d.status());
  }
}

export async function loginAndReset(page: Page): Promise<void> {
  await apiLogin(page.request);
  await resetNotes(page.request);
}
