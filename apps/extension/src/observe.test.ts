// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { parseProfile } from "./profile.js";
import {
  dateFromHeading,
  fingerprint,
  parseThread,
  timeOfDay,
} from "./thread.js";
const visible = { isVisible: (e: Element) => !e.hasAttribute("hidden") };
function page(html: string) {
  document.body.innerHTML = html;
  return document;
}
const path = "/in/person-one/";
describe("profile page", () => {
  it("reads the top card only: name, degree, actions, member key and the message link", () => {
    const doc = page(`
      <header><button aria-label="Me"></button></header>
      <main>
        <section>
          <h2>Person One</h2><p>· 2nd</p><p>Engineer at Example</p>
          <a componentkey="ConnectButtonstate:invitation:urn:li:member:123456789_connect" href="/preload/connect/person-one/?origin=x">Connect</a>
          <a href="/messaging/compose/?recipient=urn%3Ali%3Afsd_profile%3AAbc">Message</a>
          <button>More</button>
          <span hidden>1st</span>
        </section>
        <section><h2>People also viewed</h2><button componentkey="ConnectButtonstate:invitation:urn:li:member:999_connect">Connect</button><p>· 1st</p></section>
      </main>`);
    const o = parseProfile(doc, visible, path);
    expect(o.displayName).toBe("Person One");
    expect(o.relationship).toBe("2nd");
    expect(o.profileKey).toBe("urn:li:member:123456789");
    expect(o.actions).toEqual(["Connect", "Message", "More"]);
    expect(o.connection).toBe("NotConnected");
    expect(o.messageHref).toContain("/messaging/compose/");
    expect(o.profilePath).toBe("/in/person-one/");
    expect(o.unreadable).toBe(false);
  });
  it("maps Pending and first-degree cards and flags a card with nothing readable", () => {
    const pending = parseProfile(
      page(
        `<main><section><h1>Two</h1><p>· 3rd</p><button>Pending</button></section></main>`,
      ),
      visible,
    );
    expect(pending.connection).toBe("Pending");
    const connected = parseProfile(
      page(
        `<main><section><h1>Three</h1><p>· 1st</p><a href="/messaging/thread/abc/">Message</a></section></main>`,
      ),
      visible,
    );
    expect(connected.connection).toBe("Connected");
    expect(connected.relationship).toBe("1st");
    const unreadable = parseProfile(
      page(`<main><section><div>Loading</div></section></main>`),
      visible,
    );
    expect(unreadable.unreadable).toBe(true);
    expect(unreadable.connection).toBe("Unknown");
    const messageOnly = parseProfile(
      page(
        `<main><section><h1>Four</h1><p>· 2nd</p><a href="/messaging/compose/">Message</a></section></main>`,
      ),
      visible,
    );
    expect(messageOnly.connection).toBe("Unknown");
  });
});
describe("thread page", () => {
  const now = new Date(2026, 10, 4, 15, 0); // Wednesday 4 November 2026, local time
  it("resolves relative and short date headings against the clock", () => {
    expect(dateFromHeading("Today", now)?.getDate()).toBe(4);
    expect(dateFromHeading("Yesterday", now)?.getDate()).toBe(3);
    expect(dateFromHeading("Tuesday", now)?.getDate()).toBe(3);
    expect(dateFromHeading("Wednesday", now)?.getDate()).toBe(28);
    expect(dateFromHeading("Nov 1", now)?.getMonth()).toBe(10);
    expect(dateFromHeading("Dec 20", now)?.getFullYear()).toBe(2025);
    expect(dateFromHeading("Jan 5, 2024", now)?.getFullYear()).toBe(2024);
    expect(dateFromHeading("Someday", now)).toBeNull();
    expect(timeOfDay("9:05 PM")).toEqual({ hours: 21, minutes: 5 });
    expect(timeOfDay("12:10 AM")).toEqual({ hours: 0, minutes: 10 });
    expect(timeOfDay("23:59")).toEqual({ hours: 23, minutes: 59 });
    expect(timeOfDay("noon")).toBeNull();
  });
  it("attributes direction by the signed-in name, carries sender and time across a group, and never reads bodies", async () => {
    document.body.innerHTML = `
      <ul class="msg-s-message-list-content">
        <li class="msg-s-message-list__top-of-list"></li>
        <li class="msg-s-message-list__loader" hidden></li>
        <li class="msg-s-message-list__event">
          <time class="msg-s-message-list__time-heading">Tuesday</time>
          <span class="msg-s-message-group__name">Person One</span>
          <time class="msg-s-message-group__timestamp">9:05 AM</time>
          <div data-event-urn="urn:li:msg_message:(a,1)"><p class="msg-s-event-listitem__body">private text</p></div>
        </li>
        <li class="msg-s-message-list__event"><div data-event-urn="urn:li:msg_message:(a,2)"><p class="msg-s-event-listitem__body">more</p></div></li>
        <li class="msg-s-message-list__event">
          <span class="msg-s-message-group__profile-link">Self Name</span>
          <time class="msg-s-message-group__timestamp">10:30 AM</time>
          <div data-event-urn="urn:li:msg_message:(a,3)"></div>
        </li>
        <li class="msg-s-message-list__bottom-of-list"></li>
      </ul>`;
    const t = parseThread(document, visible, "Self Name", now);
    expect(t.messages.map((m) => m.direction)).toEqual([
      "incoming",
      "incoming",
      "outgoing",
    ]);
    expect(t.messages[0]!.at.getDate()).toBe(3);
    expect(t.messages[0]!.at.getHours()).toBe(9);
    expect(t.messages[2]!.at.getHours()).toBe(10);
    expect(t.complete).toBe(true);
    expect(JSON.stringify(t)).not.toContain("private text");
    const prints = await Promise.all(
      t.messages.map((m) => fingerprint(m.eventId)),
    );
    expect(new Set(prints).size).toBe(3);
    expect(prints[0]).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const unknownSelf = parseThread(document, visible, null, now);
    expect(unknownSelf.messages).toEqual([]);
    expect(unknownSelf.complete).toBe(false);
    expect(unknownSelf.skipped).toBe(3);
  });
  it("is incomplete while older messages are still loading or a heading is unreadable", () => {
    document.body.innerHTML = `
      <ul class="msg-s-message-list-content">
        <li class="msg-s-message-list__loader"></li>
        <li class="msg-s-message-list__event">
          <time class="msg-s-message-list__time-heading">Someday</time>
          <span class="msg-s-message-group__name">Person One</span>
          <time class="msg-s-message-group__timestamp">9:05 AM</time>
          <div data-event-urn="urn:li:msg_message:(a,1)"></div>
        </li>
        <li class="msg-s-message-list__bottom-of-list"></li>
      </ul>`;
    const t = parseThread(document, visible, "Self Name", now);
    expect(t.messages).toEqual([]);
    expect(t.skipped).toBe(1);
    expect(t.complete).toBe(false);
  });
});
