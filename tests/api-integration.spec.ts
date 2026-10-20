import { test, expect } from "@playwright/test";
import { apiLogin, resetNotes, PASSWORD, YT_URL, YT_ID } from "./helpers";

type Id = { id: string };
const ids = (r: { notes: Id[] }) => r.notes.map((n) => n.id);

test.describe("API integration: auth", () => {
  test("unauthenticated requests get 401 JSON", async ({ playwright, baseURL }) => {
    const anon = await playwright.request.newContext({ baseURL });
    for (const path of ["/api/notes", "/api/me", "/api/search?q=x", "/api/export", "/api/tags", "/api/prefs"]) {
      const res = await anon.get(path);
      expect(res.status(), path).toBe(401);
      expect(await res.json()).toHaveProperty("error");
    }
    await anon.dispose();
  });

  test("wrong password -> 401 and no session cookie", async ({ playwright, baseURL }) => {
    const anon = await playwright.request.newContext({
      baseURL,
      extraHTTPHeaders: { "cf-connecting-ip": "198.51.100.10" },
    });
    const res = await anon.post("/api/login", { data: { password: "definitely-wrong" } });
    expect(res.status()).toBe(401);
    expect(res.headers()["set-cookie"]).toBeUndefined();
    expect((await anon.get("/api/me")).status()).toBe(401);
    await anon.dispose();
  });

  test("login -> /api/me ok, cookie flags, logout invalidates session", async ({ playwright, baseURL }) => {
    const ctx = await playwright.request.newContext({ baseURL });
    const res = await ctx.post("/api/login", { data: { password: PASSWORD } });
    expect(res.status()).toBe(204);
    const cookie = res.headers()["set-cookie"] ?? "";
    expect(cookie).toContain("ownnote_session=");
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);

    const me = await ctx.get("/api/me");
    expect(me.status()).toBe(200);
    expect(await me.json()).toEqual({ ok: true });

    expect((await ctx.post("/api/logout")).status()).toBe(204);
    expect((await ctx.get("/api/me")).status()).toBe(401);
    await ctx.dispose();
  });

  test("a logged-out session cookie cannot be replayed", async ({ playwright, baseURL }) => {
    const a = await playwright.request.newContext({ baseURL });
    await apiLogin(a);
    const storage = await a.storageState();
    await a.post("/api/logout");
    const b = await playwright.request.newContext({ baseURL, storageState: storage });
    expect((await b.get("/api/notes")).status()).toBe(401);
    await a.dispose();
    await b.dispose();
  });

  test("rate limits repeated wrong passwords (429 + Retry-After)", async ({ playwright, baseURL }) => {
    // The Worker keys its limiter on cf-connecting-ip; use a unique IP so other tests are unaffected.
    const ctx = await playwright.request.newContext({
      baseURL,
      extraHTTPHeaders: { "cf-connecting-ip": `203.0.113.${Math.floor(Math.random() * 200) + 1}` },
    });
    const statuses: number[] = [];
    let last;
    for (let i = 0; i < 6; i++) {
      last = await ctx.post("/api/login", { data: { password: "nope-nope" } });
      statuses.push(last.status());
    }
    expect(statuses).toEqual([401, 401, 401, 401, 401, 429]);
    expect(last!.headers()["retry-after"]).toBeTruthy();
    // even the right password is refused while locked out
    expect((await ctx.post("/api/login", { data: { password: PASSWORD } })).status()).toBe(429);
    await ctx.dispose();
  });

  test("cross-origin mutating request is blocked (403)", async ({ playwright, baseURL }) => {
    const ctx = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { origin: "https://evil.example" } });
    expect((await ctx.post("/api/login", { data: { password: PASSWORD } })).status()).toBe(403);
    await ctx.dispose();
  });

  test("unknown /api path returns JSON 404, not the SPA", async ({ request }) => {
    await apiLogin(request);
    const res = await request.get("/api/nope");
    expect(res.status()).toBe(404);
    expect(res.headers()["content-type"]).toContain("application/json");
  });
});

test.describe("API integration: notes, search, videos, export", () => {
  test.beforeEach(async ({ request }) => {
    await apiLogin(request);
    await resetNotes(request);
  });

  test("create / read / patch / list / delete", async ({ request }) => {
    const created = await request.post("/api/notes", { data: { title: "Integration note" } });
    expect(created.status()).toBe(200);
    const { note } = await created.json();
    expect(note).toMatchObject({ title: "Integration note", pinned: false, tags: [] });
    expect(note.content).toMatchObject({ type: "doc" });

    const got = await request.get(`/api/notes/${note.id}`);
    expect(got.status()).toBe(200);
    expect((await got.json()).note.id).toBe(note.id);

    const content = {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "zebrafish pipeline notes" }] }],
    };
    const patched = await request.patch(`/api/notes/${note.id}`, { data: { title: "Renamed", content, pinned: true } });
    expect(patched.status()).toBe(200);
    const p = (await patched.json()).note;
    expect(p).toMatchObject({ title: "Renamed", pinned: true });
    expect(p.pinned_at).toBeTruthy();
    expect(p.content).toEqual(content);

    const list = await (await request.get("/api/notes")).json();
    expect(ids(list)).toEqual([note.id]);
    expect(list.notes[0]).not.toHaveProperty("content");

    expect((await request.delete(`/api/notes/${note.id}`)).status()).toBe(204);
    expect((await request.get(`/api/notes/${note.id}`)).status()).toBe(404);
    expect((await request.delete(`/api/notes/${note.id}`)).status()).toBe(404);
  });

  test("validation errors", async ({ request }) => {
    expect((await request.post("/api/notes", { data: { content: "not-an-object" } })).status()).toBe(400);
    const { note } = await (await request.post("/api/notes", { data: {} })).json();
    expect(note.title).toBe("Untitled");
    expect((await request.patch(`/api/notes/${note.id}`, { data: { pinned: "yes" } })).status()).toBe(400);
    expect((await request.patch("/api/notes/does-not-exist", { data: { title: "x" } })).status()).toBe(404);
  });

  test("search finds by title and body; tags + tag filter", async ({ request }) => {
    const a = (await (await request.post("/api/notes", { data: { title: "Quantum gardening" } })).json()).note;
    const b = (await (await request.post("/api/notes", { data: { title: "Other" } })).json()).note;
    await request.patch(`/api/notes/${b.id}`, {
      data: { content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "axolotl regeneration" }] }] } },
    });

    expect(ids(await (await request.get("/api/search?q=quantum")).json())).toEqual([a.id]);
    expect(ids(await (await request.get("/api/search?q=axolotl")).json())).toEqual([b.id]);
    expect((await (await request.get("/api/search?q=nomatchxyz")).json()).notes).toEqual([]);

    const tags = await request.put(`/api/notes/${b.id}/tags`, { data: { tags: ["Bio", "bio", "lab"] } });
    expect(tags.status()).toBe(200);
    expect((await tags.json()).tags.sort()).toEqual(["Bio", "lab"]);
    expect(ids(await (await request.get("/api/notes?tag=lab")).json())).toEqual([b.id]);
    expect(ids(await (await request.get("/api/search?q=other&tag=lab")).json())).toEqual([b.id]);
  });

  test("videos: add, duplicate, invalid url, status, reorder, delete", async ({ request }) => {
    const { note } = await (await request.post("/api/notes", { data: { title: "With videos" } })).json();

    const add = await request.post(`/api/notes/${note.id}/videos`, { data: { url: YT_URL } });
    expect(add.status()).toBe(200);
    const { video } = await add.json();
    expect(video).toMatchObject({ note_id: note.id, youtube_id: YT_ID, status: "unwatched" });
    expect(video.title).toBeTruthy();

    expect((await request.post(`/api/notes/${note.id}/videos`, { data: { url: YT_URL } })).status()).toBe(409);
    expect((await request.post(`/api/notes/${note.id}/videos`, { data: { url: "https://example.com/x" } })).status()).toBe(400);

    const second = (await (await request.post(`/api/notes/${note.id}/videos`, { data: { url: "https://youtu.be/9bZkp7q19f0" } })).json()).video;
    const order = await request.put(`/api/notes/${note.id}/videos/order`, { data: { ids: [second.id, video.id] } });
    expect(order.status()).toBe(200);
    expect((await order.json()).videos.map((v: Id) => v.id)).toEqual([second.id, video.id]);

    const done = await request.patch(`/api/videos/${video.id}`, { data: { status: "done" } });
    expect((await done.json()).video.status).toBe("done");
    expect((await request.patch(`/api/videos/${video.id}`, { data: { status: "bogus" } })).status()).toBe(400);

    expect((await (await request.get(`/api/notes/${note.id}/videos`)).json()).videos).toHaveLength(2);

    expect((await request.delete(`/api/videos/${video.id}`)).status()).toBe(204);
    expect((await request.delete(`/api/videos/${video.id}`)).status()).toBe(404);
    expect((await (await request.get(`/api/notes/${note.id}/videos`)).json()).videos).toHaveLength(1);
  });

  test("watch progress + prefs round-trip", async ({ request }) => {
    const put = await request.put(`/api/watch/${YT_ID}`, { data: { position_seconds: 42, duration_seconds: 212 } });
    expect(await put.json()).toEqual({ position_seconds: 42, duration_seconds: 212 });
    expect(await (await request.get(`/api/watch/${YT_ID}`)).json()).toEqual({ position_seconds: 42, duration_seconds: 212 });
    expect((await request.put(`/api/watch/${YT_ID}`, { data: { position_seconds: -1 } })).status()).toBe(400);
    expect((await request.get("/api/watch/bad")).status()).toBe(400);

    const { note } = await (await request.post("/api/notes", { data: {} })).json();
    const prefs = await request.put("/api/prefs", { data: { last_note_id: note.id } });
    expect((await prefs.json()).last_note_id).toBe(note.id);
    expect((await request.put("/api/prefs", { data: { last_note_id: "missing" } })).status()).toBe(404);
  });

  test("templates and from-template", async ({ request }) => {
    const { templates } = await (await request.get("/api/templates")).json();
    expect(templates.map((t: { key: string }) => t.key)).toContain("learning_journey");
    const res = await request.post("/api/notes/from-template", { data: { key: "learning_journey", title: "My journey" } });
    expect(res.status()).toBe(200);
    expect((await res.json()).note).toMatchObject({ title: "My journey", template_key: "learning_journey" });
    expect((await request.post("/api/notes/from-template", { data: { key: "nope" } })).status()).toBe(400);
  });

  test("export json + markdown", async ({ request }) => {
    const { note } = await (await request.post("/api/notes", { data: { title: "Exported note" } })).json();
    await request.post(`/api/notes/${note.id}/videos`, { data: { url: YT_URL } });

    const json = await request.get("/api/export?format=json");
    expect(json.status()).toBe(200);
    expect(json.headers()["content-disposition"]).toContain("attachment");
    const body = await json.json();
    expect(body.version).toBe(1);
    expect(body.notes.find((n: Id) => n.id === note.id).videos).toHaveLength(1);

    const md = await request.get("/api/export?format=markdown");
    expect(md.status()).toBe(200);
    expect(md.headers()["content-type"]).toContain("text/markdown");
    const text = await md.text();
    expect(text).toContain("# Exported note");
    expect(text).toContain(YT_ID);

    expect((await request.get("/api/export?format=xml")).status()).toBe(400);
  });
});
