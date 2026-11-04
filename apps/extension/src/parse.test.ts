// @vitest-environment jsdom
import { expect, it } from "vitest";
import {
  findResultRows,
  parseResultRow,
  parseSelf,
  profileKeyFromHref,
  visibleText,
} from "./parse.js";
const isVisible = (e: Element) =>
  !e.hasAttribute("data-hidden") && !e.closest("[data-hidden]");
function row(html: string) {
  document.body.innerHTML = `<main><ul><li data-row>${html}</li></ul></main>`;
  return document.querySelector("li[data-row]")!;
}
const full = `
  <a href="/in/ada-example?miniProfileUrn=urn%3Ali%3Afsd_profile%3AACoAAabc_12"><span class="visually-hidden">View Ada Example's profile</span><span>Ada Example</span></a>
  <span class="visually-hidden">• 1st degree connection</span><span data-hidden>1st</span><span>• 2nd</span>
  <div><span>Software Engineer at Example Systems</span></div>
  <div>Toronto, Canada</div>
  <button><span>Connect</span></button>
  <div>Current: Software Engineer at Example Systems</div>`;
it("reads only visible text and takes the visible relationship over hidden text", () => {
  const parsed = parseResultRow(row(full), { isVisible });
  expect(parsed).toEqual({
    profileKey: "urn:li:fsd_profile:ACoAAabc_12",
    profilePath: "/in/ada-example/",
    displayName: "Ada Example",
    headline: "Software Engineer at Example Systems",
    location: "Toronto, Canada",
    current: "Current: Software Engineer at Example Systems",
    relationship: "2nd",
    action: "Connect",
    missing: [],
  });
});
it("takes the name from the shortest profile link when the whole card is a link", () => {
  const parsed = parseResultRow(
    row(
      `<a href="/in/card-person/"><div><p><a href="/in/card-person/"><span>Card Person</span></a><span>• 2nd</span></p><div><p><span>Engineer at Example</span></p></div><div><p><span>Lagos, Nigeria</span></p></div><div><span><a>Connect</a></span></div><div><p><span>Current: </span><span><strong>Engineer</strong> at <strong>Example</strong></span></p></div></div></a>`,
    ),
    { isVisible },
  );
  expect(parsed.displayName).toBe("Card Person");
  expect(parsed.headline).toBe("Engineer at Example");
  expect(parsed.location).toBe("Lagos, Nigeria");
  expect(parsed.current).toBe("Current: Engineer at Example");
  expect(parsed.relationship).toBe("2nd");
  expect(parsed.action).toBe("Connect");
});
it("reports missing key, headline and location instead of inventing them", () => {
  const parsed = parseResultRow(
    row(
      `<a href="/in/no-key/"><span>No Key</span></a><span>• 3rd</span><button>Follow</button>`,
    ),
    { isVisible },
  );
  expect(parsed.profileKey).toBeNull();
  expect(parsed.action).toBe("Follow");
  expect(parsed.missing).toEqual(["profileKey", "headline", "location"]);
});
it("maps Pending and Message actions and never reads hidden blocks", () => {
  const pending = parseResultRow(
    row(
      `<a href="/in/p/?miniProfileUrn=urn:li:fsd_profile:ACoAAp"><span>P Person</span></a><span>• 2nd</span><div data-hidden>Secret hidden headline</div><div>Visible headline</div><div>Berlin</div><button>Pending</button>`,
    ),
    { isVisible },
  );
  expect(pending.action).toBe("Pending");
  expect(pending.headline).toBe("Visible headline");
  expect(
    visibleText(row(`<div data-hidden>hidden</div><div>shown</div>`), {
      isVisible,
    }),
  ).toBe("shown");
});
it("finds result rows once each inside main and the self identity only in the navigation", () => {
  document.body.innerHTML = `<header id="global-nav"><a href="/in/self-person/?miniProfileUrn=urn:li:fsd_profile:ACoAAself">Me</a></header><main><ul>
    <li><a href="/in/one/">One</a></li><li><a href="/in/one/">One again</a></li><li><a href="/in/two/">Two</a></li><li><span>no link</span></li></ul></main>`;
  expect(findResultRows(document).map((r) => r.textContent?.trim())).toEqual([
    "One",
    "Two",
  ]);
  document.body.innerHTML = `<main><div role="list"><div role="listitem"><div><a href="/in/alpha/">Alpha</a></div><p>• 2nd</p><a componentkey="C:i:urn:li:member:123456789">Connect</a></div><div role="listitem"><a href="/in/beta/">Beta</a></div><div role="listitem"><div role="listitem"><a href="/in/nested/">Nested</a></div></div></div></main>`;
  expect(
    findResultRows(document).map((r) => r.querySelector("a")?.textContent),
  ).toEqual(["Alpha", "Beta", "Nested"]);
  const alpha = parseResultRow(findResultRows(document)[0]!, { isVisible });
  expect(alpha.profileKey).toBe("urn:li:member:123456789");
  expect(alpha.action).toBe("Connect");
  document.body.innerHTML = `<header><button>Me</button><div><a href="/in/self-vanity/">View Profile</a></div></header><main><div role="listitem"><a href="/in/one/">One</a></div></main>`;
  expect(parseSelf(document)).toEqual({
    profileKey: null,
    profilePath: "/in/self-vanity/",
  });
  document.body.innerHTML = `<header id="global-nav"><a href="/in/self-person/?miniProfileUrn=urn:li:fsd_profile:ACoAAself">Me</a></header><main><ul>
    <li><a href="/in/one/">One</a></li><li><a href="/in/one/">One again</a></li><li><a href="/in/two/">Two</a></li><li><span>no link</span></li></ul></main>`;
  expect(findResultRows(document).map((r) => r.textContent?.trim())).toEqual([
    "One",
    "Two",
  ]);
  expect(parseSelf(document)).toEqual({
    profileKey: "urn:li:fsd_profile:ACoAAself",
    profilePath: "/in/self-person/",
  });
  expect(
    profileKeyFromHref(
      "https://www.linkedin.com/in/x?miniProfileUrn=urn%3Ali%3Afsd_profile%3AAbC-9",
    ),
  ).toBe("urn:li:fsd_profile:AbC-9");
  expect(profileKeyFromHref("/in/x")).toBeNull();
});
