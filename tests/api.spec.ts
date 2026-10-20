import { test, expect } from "@playwright/test";
import { apiLogin, resetNotes, PASSWORD, YT_URL, YT_ID } from "./helpers";

test.describe.configure({ mode: "serial" });

test.describe("API integration", () => {
  test("unauthenticated /api/notes returns 401", async ({ request }) => {
    const res = await request.get("/api/notes");
    expect(res.status()).toBe(401);
  });

  test("login rejects wrong password", async ({ request }) => {
    const res = await request.post("/api/login", {
      data: { password: "wrong-password-xx" },
      headers: { "cf-connecting-ip": `e2e-bad-${Date.now()}` },
    });
    expect(res.status()).toBe(401);
  });

  test("login succeeds and notes CRUD works", async ({ request }) => {
    await apiLogin(request);
    await resetNotes(request);

    const created = await request.post("/api/notes", {
      data: { title: "API Journey", content: { type: "doc", content: [] } },
    });
    expect(created.status()).toBe(200);
    const { note } = (await created.json()) as { note: { id: string; title: string } };
    expect(note.title).toBe("API Journey");

    const patched = await request.patch(`/api/notes/${note.id}`, {
      data: { title: "API Journey Updated" },
    });
    expect(patched.status()).toBe(200);

    const listed = await request.get("/api/notes");
    expect(listed.status()).toBe(200);
    const { notes } = (await listed.json()) as { notes: { id: string; title: string }[] };
    expect(notes.some((n) => n.id === note.id && n.title === "API Journey Updated")).toBe(true);

    const search = await request.get("/api/search?q=Journey");
    expect(search.status()).toBe(200);
    const found = (await search.json()) as { notes: { id: string }[] };
    expect(found.notes.some((n) => n.id === note.id)).toBe(true);

    const vid = await request.post(`/api/notes/${note.id}/videos`, { data: { url: YT_URL } });
    expect(vid.status()).toBe(200);
    const { video } = (await vid.json()) as { video: { id: string; youtube_id: string } };
    expect(video.youtube_id).toBe(YT_ID);

    const done = await request.patch(`/api/videos/${video.id}`, { data: { status: "done" } });
    expect(done.status()).toBe(200);

    const delVid = await request.delete(`/api/videos/${video.id}`);
    expect(delVid.status()).toBe(204);

    const exp = await request.get("/api/export?format=json");
    expect(exp.status()).toBe(200);
    expect(exp.headers()["content-type"] ?? "").toMatch(/json/);

    const del = await request.delete(`/api/notes/${note.id}`);
    expect(del.status()).toBe(204);
  });

  test("logout clears session", async ({ request }) => {
    await apiLogin(request);
    const out = await request.post("/api/logout");
    expect(out.status()).toBe(204);
    const notes = await request.get("/api/notes");
    expect(notes.status()).toBe(401);
  });
});
