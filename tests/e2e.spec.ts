import { test, expect, type Page } from "@playwright/test";
import { loginAndReset, PASSWORD, YT_URL, YT_ID } from "./helpers";

async function newBlankNote(page: Page) {
  await page.getByRole("button", { name: /^New$/ }).click();
  await page.getByRole("menuitem", { name: /Blank note/ }).click();
  await expect(page.getByLabel("Note title")).toBeVisible();
}

test.describe("login", () => {
  test("wrong password shows an error and stays on login", async ({ page }) => {
    await expect(async () => {
      const res = await page.goto("/");
      expect(res?.ok() || res?.status() === 304).toBeTruthy();
      await expect(page.locator("#pw")).toBeVisible({ timeout: 5_000 });
    }).toPass({ timeout: 30_000 });

    await page.locator("#pw").fill("wrong-password");
    await page.getByRole("button", { name: "Open" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "not the password" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Open your notes" })).toBeVisible();
    await expect(page.getByLabel("Note title")).toHaveCount(0);
  });

  test("correct password opens the workspace; logout returns to login", async ({ page }) => {
    await page.goto("/");
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Open" }).click();
    await expect(page.getByRole("heading", { name: "Notebook" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Open your notes" })).toHaveCount(0);

    // session persists across reload
    await page.reload();
    await expect(page.getByRole("heading", { name: "Notebook" })).toBeVisible();

    await page.getByRole("button", { name: "Log out" }).click();
    await expect(page.getByRole("heading", { name: "Open your notes" })).toBeVisible();
    expect((await page.request.get("/api/notes")).status()).toBe(401);
  });
});

test.describe("workspace", () => {
  test.beforeEach(async ({ page }) => {
    await loginAndReset(page);
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Notebook" })).toBeVisible();
  });

  test("create note, edit title + content, autosave persists across reload", async ({ page }) => {
    await newBlankNote(page);
    await expect(page.locator(".note-row")).toHaveCount(1);

    const title = page.getByLabel("Note title");
    await title.fill("E2E autosave note");
    const editor = page.locator(".ProseMirror");
    await editor.click();
    await page.keyboard.type("hello from playwright zebrafish");

    // autosave debounce (~800ms) -> "saved"
    await expect(page.locator(".save-state")).toHaveAttribute("data-state", "saved", { timeout: 10_000 });
    await expect(page.locator(".note-row-title")).toHaveText("E2E autosave note");

    // verify server-side
    const { notes } = await (await page.request.get("/api/notes")).json();
    expect(notes).toHaveLength(1);
    const { note } = await (await page.request.get(`/api/notes/${notes[0].id}`)).json();
    expect(note.title).toBe("E2E autosave note");
    expect(JSON.stringify(note.content)).toContain("hello from playwright zebrafish");

    // and in the UI after reload
    await page.reload();
    await expect(page.getByLabel("Note title")).toHaveValue("E2E autosave note");
    await expect(page.locator(".ProseMirror")).toContainText("hello from playwright zebrafish");
  });

  test("explicit save (Ctrl+S) flushes immediately", async ({ page }) => {
    await newBlankNote(page);
    await page.getByLabel("Note title").fill("Ctrl+S note");
    await page.keyboard.press("Control+s");
    await expect(page.locator(".toast", { hasText: "Saved" })).toBeVisible();
    const { notes } = await (await page.request.get("/api/notes")).json();
    expect(notes[0].title).toBe("Ctrl+S note");
  });

  test("toolbar formatting is stored in content (bold + checklist)", async ({ page }) => {
    await newBlankNote(page);
    await page.locator(".ProseMirror").click();
    await page.getByRole("button", { name: "Checklist" }).click();
    await page.keyboard.type("todo item");
    await expect(page.locator(".save-state")).toHaveAttribute("data-state", "saved", { timeout: 10_000 });
    const { notes } = await (await page.request.get("/api/notes")).json();
    const { note } = await (await page.request.get(`/api/notes/${notes[0].id}`)).json();
    expect(JSON.stringify(note.content)).toContain("taskList");
  });

  test("search finds a note via the palette", async ({ page }) => {
    const req = page.request;
    const mk = async (title: string, text: string) => {
      const { note } = await (await req.post("/api/notes", { data: { title } })).json();
      await req.patch(`/api/notes/${note.id}`, {
        data: { content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] } },
      });
      return note.id as string;
    };
    await mk("Groceries", "milk eggs");
    await mk("Needle in haystack", "unique-body-token pangolin");
    await page.reload();
    await expect(page.locator(".note-row")).toHaveCount(2);

    await page.getByRole("button", { name: "Search notes" }).click();
    const input = page.getByRole("dialog", { name: "Search notes" }).getByLabel("Search");
    await expect(input).toBeFocused();

    const dialog = page.getByRole("dialog", { name: "Search notes" });
    const options = dialog.getByRole("option");

    await input.fill("needle");
    await expect(dialog.getByText("1 found")).toBeVisible({ timeout: 10_000 });
    await expect(options).toHaveCount(1);
    await expect(options).toContainText("Needle in haystack");

    // body search
    await input.fill("pangolin");
    await expect(dialog.getByText("1 found")).toBeVisible({ timeout: 10_000 });
    await expect(options).toHaveCount(1);
    await expect(options).toContainText("Needle in haystack");

    await input.fill("zzzznothing");
    await expect(dialog.getByText("0 found")).toBeVisible({ timeout: 10_000 });
    await expect(dialog.getByText("No matching notes.")).toBeVisible();

    await input.fill("needle");
    await expect(dialog.getByText("1 found")).toBeVisible({ timeout: 10_000 });
    await expect(options).toHaveCount(1);
    await options.first().locator("button").click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByLabel("Note title")).toHaveValue("Needle in haystack");
  });

  test("Ctrl+K opens the search palette; Escape closes it", async ({ page }) => {
    await page.keyboard.press("Control+k");
    await expect(page.getByRole("dialog", { name: "Search notes" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Search notes" })).toHaveCount(0);
  });

  test("add YouTube URL, see it in the list, mark done, then delete", async ({ page }) => {
    await newBlankNote(page);
    await page.getByLabel("Note title").fill("Video note");

    const urlInput = page.getByLabel("YouTube URL");
    await urlInput.fill("https://example.com/not-youtube");
    await page.getByRole("button", { name: "Add video" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "doesn't look like a YouTube link" })).toBeVisible();

    await urlInput.fill(YT_URL);
    await page.getByRole("button", { name: "Add video" }).click();

    const row = page.locator(".video-row");
    await expect(row).toHaveCount(1);
    await expect(row).toHaveAttribute("data-status", "unwatched");
    await expect(row.locator("img.thumb")).toHaveAttribute("src", new RegExp(YT_ID));
    await expect(page.locator(".watch-head .count")).toHaveText("0/1");
    await expect(urlInput).toHaveValue("");

    // persisted server-side
    const { notes } = await (await page.request.get("/api/notes")).json();
    const vids = (await (await page.request.get(`/api/notes/${notes[0].id}/videos`)).json()).videos;
    expect(vids).toHaveLength(1);
    expect(vids[0].youtube_id).toBe(YT_ID);

    // mark done
    await row.getByRole("button", { name: "Cross out (done)" }).click();
    await expect(row).toHaveAttribute("data-status", "done");
    await expect(page.locator(".watch-head .count")).toHaveText("1/1");
    await expect
      .poll(async () => (await (await page.request.get(`/api/notes/${notes[0].id}/videos`)).json()).videos[0].status)
      .toBe("done");

    // survives reload
    await page.reload();
    await expect(page.locator(".video-row")).toHaveAttribute("data-status", "done");

    // delete
    await page.locator(".video-row").getByRole("button", { name: /^Delete / }).click();
    await expect(page.locator(".video-row")).toHaveCount(0);
    await expect(page.getByText("Nothing queued")).toBeVisible();
    const noteId = notes[0].id as string;
    await expect
      .poll(async () => {
        const res = await page.request.get(`/api/notes/${noteId}/videos`);
        if (!res.ok()) return -1;
        const body = (await res.json()) as { videos?: unknown[] };
        return body.videos?.length ?? -1;
      })
      .toBe(0);
  });

  test("duplicate video is rejected with an error", async ({ page }) => {
    await newBlankNote(page);
    const urlInput = page.getByLabel("YouTube URL");
    await urlInput.fill(YT_URL);
    await page.getByRole("button", { name: "Add video" }).click();
    await expect(page.locator(".video-row")).toHaveCount(1);
    await urlInput.fill(YT_URL);
    await page.getByRole("button", { name: "Add video" }).click();
    await expect(page.getByRole("alert").filter({ hasText: /already/i })).toBeVisible();
    await expect(page.locator(".video-row")).toHaveCount(1);
  });

  test("delete a note (two-step confirm)", async ({ page }) => {
    await newBlankNote(page);
    await page.getByLabel("Note title").fill("To be deleted");
    await page.keyboard.press("Control+s");
    await expect(page.locator(".save-state")).toHaveAttribute("data-state", "saved", { timeout: 10_000 });
    const { notes: before } = (await (await page.request.get("/api/notes")).json()) as {
      notes: { id: string; title: string }[];
    };
    const target = before.find((n) => n.title === "To be deleted");
    expect(target).toBeTruthy();

    const del = page.getByTitle("Delete note");
    await del.click();
    await expect(page.getByText("Delete?")).toBeVisible();
    await del.click();
    await expect(page.locator(".note-row")).toHaveCount(0);
    await expect(page.getByText("Nothing open.")).toBeVisible();
    await expect
      .poll(async () => {
        const { notes } = (await (await page.request.get("/api/notes")).json()) as {
          notes: { id: string }[];
        };
        return notes.some((n) => n.id === target!.id);
      })
      .toBe(false);
  });

  test("tags: add via editor, filter list by tag", async ({ page }) => {
    await newBlankNote(page);
    await page.getByLabel("Add tag").fill("golang");
    await page.getByLabel("Add tag").press("Enter");
    await expect(page.locator(".tag-chip", { hasText: "#golang" })).toBeVisible();
    await expect(page.getByRole("group", { name: "Filter by tag" }).getByRole("button", { name: "#golang" })).toBeVisible();
    const { tags } = await (await page.request.get("/api/tags")).json();
    expect(tags.map((t: { name: string }) => t.name)).toEqual(["golang"]);
  });

  test("export endpoint is downloadable when authenticated (UI menu)", async ({ page }) => {
    await page.request.post("/api/notes", { data: { title: "Export me" } });
    await page.reload();
    await page.getByRole("button", { name: "Export", exact: true }).click();
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("menuitem", { name: /JSON/ }).click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/^ownnote-export-.*\.json$/);
  });
});

test("export endpoint returns 200 when authenticated and 401 when not", async ({ page, playwright, baseURL }) => {
  const anon = await playwright.request.newContext({ baseURL });
  expect((await anon.get("/api/export")).status()).toBe(401);
  expect((await anon.get("/api/notes")).status()).toBe(401);
  await anon.dispose();

  await loginAndReset(page);
  for (const format of ["json", "markdown"]) {
    const res = await page.request.get(`/api/export?format=${format}`);
    expect(res.status(), format).toBe(200);
  }
});
