import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const CREATOR_NAME = "Lucas Leandro Ramos";
const CREATOR_LINKEDIN = "https://www.linkedin.com/in/lucasleandro1204/";

function loadDocument(): Document {
  const html = readFileSync(resolve(process.cwd(), "index.html"), "utf8");
  return new DOMParser().parseFromString(html, "text/html");
}

describe("public creator attribution", () => {
  it("identifies Lucas and his LinkedIn profile to crawlers", () => {
    const document = loadDocument();

    expect(document.querySelector('meta[name="author"]')?.getAttribute("content")).toBe(CREATOR_NAME);
    expect(document.querySelector('link[rel="author"]')?.getAttribute("href")).toBe(CREATOR_LINKEDIN);

    const structuredData = document.querySelector('script[type="application/ld+json"]');
    expect(structuredData).not.toBeNull();

    const application = JSON.parse(structuredData?.textContent ?? "null") as {
      creator?: { name?: string; sameAs?: string[]; url?: string };
    };

    expect(application.creator).toEqual({
      "@type": "Person",
      name: CREATOR_NAME,
      sameAs: [CREATOR_LINKEDIN],
      url: CREATOR_LINKEDIN,
    });
  });
});
