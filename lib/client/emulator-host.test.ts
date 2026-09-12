import { describe, expect, it } from "vitest";

import { emulatorIsReachable, parseEmulatorHost } from "./emulator-host";

describe("parseEmulatorHost", () => {
  it("reads the pairs the emulators actually print", () => {
    expect(parseEmulatorHost("127.0.0.1:8080")).toEqual({ host: "127.0.0.1", port: 8080 });
    expect(parseEmulatorHost("localhost:9099")).toEqual({ host: "localhost", port: 9099 });
    expect(parseEmulatorHost("[::1]:8080")).toEqual({ host: "[::1]", port: 8080 });
    expect(parseEmulatorHost(" 192.168.1.50:8080 ")).toEqual({ host: "192.168.1.50", port: 8080 });
  });

  it("returns nothing rather than guessing at a missing or impossible port", () => {
    for (const bad of ["", "   ", "127.0.0.1", ":8080", "127.0.0.1:", "127.0.0.1:0", "127.0.0.1:70000", "127.0.0.1:abc"])
      expect(parseEmulatorHost(bad)).toBeNull();
  });
});

describe("emulatorIsReachable", () => {
  it("connects when the page and the emulator are on the same machine", () => {
    // `npm run dev`, and the end-to-end run against the built site.
    expect(emulatorIsReachable("127.0.0.1:8080", "127.0.0.1")).toBe(true);
    expect(emulatorIsReachable("localhost:8080", "localhost")).toBe(true);
    expect(emulatorIsReachable("127.0.0.1:8080", "localhost")).toBe(true);
    expect(emulatorIsReachable("[::1]:8080", "[::1]")).toBe(true);
  });

  it("refuses a loopback emulator when the page came from somewhere else", () => {
    // This is the leak: `.env` merged into a production build, inlining
    // 127.0.0.1 into a bundle served from a real domain. The tablet has no
    // Firestore on it, so the app must use the real project instead.
    expect(emulatorIsReachable("127.0.0.1:8080", "eurotools-a1ea6.web.app")).toBe(false);
    expect(emulatorIsReachable("localhost:9099", "qc.example.com")).toBe(false);
    expect(emulatorIsReachable("0.0.0.0:8080", "eurotools-a1ea6.firebaseapp.com")).toBe(false);
  });

  it("leaves a deliberate LAN address alone", () => {
    // Pointing a real tablet at the emulators on a workstation. Nobody
    // arrives at this by forgetting to clear an env file.
    expect(emulatorIsReachable("192.168.1.50:8080", "192.168.1.50")).toBe(true);
    expect(emulatorIsReachable("192.168.1.50:8080", "192.168.1.77")).toBe(true);
  });

  it("treats an unparseable address as no emulator at all", () => {
    expect(emulatorIsReachable("", "127.0.0.1")).toBe(false);
    expect(emulatorIsReachable("127.0.0.1", "127.0.0.1")).toBe(false);
  });
});
