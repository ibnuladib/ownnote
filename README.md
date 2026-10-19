# OwnNote

Personal password-protected notes with a YouTube study panel. Hosted on Cloudflare Workers + D1.

## Features

- Shared password login (session cookie)
- TipTap rich text: bold, font size, bullets, checkboxes
- Per-note YouTube list: drag-reorder, status, resume progress, watch queue
- Search, pins, tags, learning-journey templates, keyboard shortcuts
- Export JSON / Markdown
- Mobile-friendly stacked layout

## Quick start

```bash
npm install
cp .dev.vars.example .dev.vars   # set PASSWORD_HASH (see below)
npm run db:migrate:local
npm run worker:dev               # API + static assets via Wrangler
```

In another terminal for Vite HMR during UI work:

```bash
npm run dev
```

### Set password hash

```bash
npm run hash-password -- "your-password"
# put the printed hash into .dev.vars as PASSWORD_HASH=...
# for production: wrangler secret put PASSWORD_HASH
```

## Deploy

```bash
npx wrangler d1 create ownnote-db   # once; paste binding id into wrangler.toml
npm run db:migrate:remote
npm run hash-password -- "your-password"
npx wrangler secret put PASSWORD_HASH
npm run deploy
```

## API contract

See [docs/CONTRACT.md](docs/CONTRACT.md).

## License

MIT
