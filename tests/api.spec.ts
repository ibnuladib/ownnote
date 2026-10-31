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

    // Phase A PDF upload, progress update, byte-range stream, and delete
    const NodeBuf = (globalThis as unknown as { Buffer: { from(s: string): never } }).Buffer;
    const pdfRes = await request.post(`/api/notes/${note.id}/pdfs`, {
      multipart: {
        file: {
          name: "attention_is_all_you_need.pdf",
          mimeType: "application/pdf",
          buffer: NodeBuf.from(
            "%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Count 2 /Kids [] >> endobj\n%%EOF\n",
          ),
        },
      },
    });
    expect(pdfRes.status()).toBe(200);
    const { pdf } = (await pdfRes.json()) as {
      pdf: { id: string; title: string; page_count: number; current_page: number; status: string };
    };
    expect(pdf.title).toContain("attention");
    expect(pdf.page_count).toBe(2);

    const patchedPdf = await request.patch(`/api/pdfs/${pdf.id}`, {
      data: { current_page: 2, status: "done" },
    });
    expect(patchedPdf.status()).toBe(200);

    const pdfFile = await request.get(`/api/pdfs/${pdf.id}/file`);
    expect(pdfFile.status()).toBe(200);
    expect(pdfFile.headers()["content-type"]).toContain("application/pdf");
    const pdfBytes = new Uint8Array(await pdfFile.body());
    expect(new TextDecoder().decode(pdfBytes.subarray(0, 5))).toBe("%PDF-");

    const ranged = await request.get(`/api/pdfs/${pdf.id}/file`, {
      headers: { Range: "bytes=0-4" },
    });
    expect(ranged.status()).toBe(206);
    expect(new TextDecoder().decode(new Uint8Array(await ranged.body()))).toBe("%PDF-");

    expect((await request.delete(`/api/pdfs/${pdf.id}`)).status()).toBe(204);

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
    expect(body.src).toMatch(new RegExp(`^/api/media/youtube/${id}/stream(\\?|$)`));
    expect(body.mimeType).toContain("mp4");

    const stream = await request.get(body.src, {
      headers: { Range: "bytes=0-1023" },
    });
    expect(stream.status()).toBe(206);
    expect(stream.headers()["content-type"] ?? "").toContain("video/mp4");
    const buf = new Uint8Array(await stream.body());
    expect(buf.byteLength).toBeGreaterThan(100);
    expect(new TextDecoder().decode(buf.subarray(4, 8))).toBe("ftyp");
  });
});
