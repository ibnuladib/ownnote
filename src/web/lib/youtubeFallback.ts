/** Public Invidious-style frontends that usually allow embeds when YouTube blocks them. */
export const PROXY_INSTANCES = [
  "https://yewtu.be",
  "https://inv.nadeko.net",
  "https://invidious.fdn.fr",
  "https://vid.puffyan.us",
] as const;

export function proxyEmbedUrl(instance: string, youtubeId: string, startSeconds = 0): string {
  const u = new URL(`${instance.replace(/\/$/, "")}/embed/${youtubeId}`);
  u.searchParams.set("autoplay", "1");
  if (startSeconds > 0) u.searchParams.set("t", String(Math.floor(startSeconds)));
  return u.toString();
}

export function youtubeEmbedUrl(youtubeId: string, startSeconds = 0): string {
  const u = new URL(`https://www.youtube-nocookie.com/embed/${youtubeId}`);
  u.searchParams.set("autoplay", "1");
  u.searchParams.set("rel", "0");
  u.searchParams.set("modestbranding", "1");
  u.searchParams.set("playsinline", "1");
  u.searchParams.set("enablejsapi", "1");
  if (startSeconds > 0) u.searchParams.set("start", String(Math.floor(startSeconds)));
  return u.toString();
}
