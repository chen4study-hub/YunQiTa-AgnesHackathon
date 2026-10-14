import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { About } from "../src/components/About";

vi.mock("../src/state/context", () => ({
  useDashboard: () => ({ state: { modelCard: null, data: null } }),
}));
const publicUrl = "https://github.com/chen4study-hub/YunQiTa-AgnesHackathon";
const render = () => renderToStaticMarkup(<About />);

it("About project information links to the exact public source repository", () => {
  const html = render();
  const source = html.match(/<div class="about-source">([\s\S]*?)<\/div>/)?.[1];
  expect(source).toContain("源码仓库");
  const links = [...(source ?? "").matchAll(/<a\b[^>]*href="([^"]*)"[^>]*>/g)];
  expect(links).toHaveLength(1);
  expect(links[0][1]).toBe(publicUrl);
});

it("About source link opens in a new tab with explicit opener and referrer protection", () => {
  const link = render().match(
    /<a\b[^>]*href="https:\/\/github\.com\/chen4study-hub\/YunQiTa-AgnesHackathon"[^>]*>/,
  )?.[0];
  expect(link).toContain('target="_blank"');
  expect(link).toContain('rel="noopener noreferrer"');
});

it("About allows only the exact public repository in every GitHub link and HTML address", () => {
  const html = render();
  const githubLinks = [...html.matchAll(/<a\b[^>]*href="([^"]*)"[^>]*>/g)]
    .map((match) => match[1])
    .filter((href) => {
      const { hostname } = new URL(href, "https://about.invalid");
      return hostname === "github.com" || hostname.endsWith(".github.com");
    });
  expect(githubLinks.length).toBeGreaterThan(0);
  for (const href of githubLinks) expect(href).toBe(publicUrl);

  // Inspect raw HTML as well, including text and non-link attributes.
  // Match the full address so extra path segments, queries or fragments fail.
  const addresses = [...html.matchAll(/github\.com\/[^\s"'<>]*/gi)];
  expect(addresses.length).toBeGreaterThan(0);
  for (const [address] of addresses) {
    expect(address).toBe(publicUrl.slice("https://".length));
  }
});
