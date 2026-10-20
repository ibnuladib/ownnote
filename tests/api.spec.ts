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

  test("login succeeds and notes CRUD + videos + export work", async ({ request }) => {
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

    const search = await request.get("/api/search?q=Journey");
    expect(search.status()).toBe(200);
    const found = (await search.json()) as { notes: { id: string }[] };
    expect(found.notes.some((n) => n.id === note.id)).toBe(true);

    const vid = await request.post(`/api/notes/${note.id}/videos`, { data: { url: YT_URL } });
    expect(vid.status()).toBe(200);
    const { video } = (await vid.json()) as { video: { id: string; youtube_id: string } };
    expect(video.youtube_id).toBe(YT_ID);

    expect((await request.patch(`/api/videos/${video.id}`, { data: { status: "done" } })).status()).toBe(200);
    expect((await request.delete(`/api/videos/${video.id}`)).status()).toBe(204);

    const exp = await request.get("/api/export?format=json");
    expect(exp.status()).toBe(200);

    expect((await request.delete(`/api/notes/${note.id}`)).status()).toBe(204);
  });

  test("logout clears session", async ({ request }) => {
    await apiLogin(request);
    expect((await request.post("/api/logout")).status()).toBe(204);
    expect((await request.get("/api/notes")).status()).toBe(401);
  });

  test("resolves an in-app stream for embed-blocked video 9vM4p9NN0Ts", async ({ request }) => {
    await apiLogin(request);
    const id = "9vM4p9NN0Ts";
    const meta = await request.get(`/api/media/youtube/${id}`);
    expect(meta.status(), await meta.text()).toBe(200);
    const body = (await meta.json()) as {
      title: string;
      duration_seconds: number;
      src: string;
      mimeType: string;
    };
    expect(body.title.toLowerCase()).toContain("cs229");
    expect(body.duration_seconds).toBeGreaterThan(60);
    expect(body.src).toBe(`/api/media/youtube/${id}/stream`);
    expect(body.mimeType).toContain("mp4");

    const stream = await request.get(body.src, {
      headers: { Range: "bytes=0-1023" },
    });
    expect(stream.status()).toBe(206);
    expect(stream.headers()["content-type"] ?? "").toContain("video/mp4");
    const buf = Buffer.from(await stream.body());
    expect(buf.length).toBeGreaterThan(100);
    expect(buf.slice(4, 8).toString()).toBe("ftyp");
  });
});
