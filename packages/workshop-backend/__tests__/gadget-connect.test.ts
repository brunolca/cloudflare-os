import { describe, expect, it, vi } from "vitest";
import { GadgetUser } from "@gadgets/workshop-shared/api";
import { connectGadgetAs } from "../src/overseer.js";

vi.mock("capnweb-validate", () => ({ validateRpc: () => () => undefined }));

const USER: GadgetUser = {
  id: "alice@example.com",
  name: "Alice",
  role: "build",
  isOwner: true,
};

// How workerd reports a call to a method the Durable Object class doesn't define. connectGadgetAs
// matches this exactly, so keep it verbatim.
function notImplemented(method = "onConnect"): TypeError {
  return new TypeError(
      `The RPC receiver does not implement the method ${JSON.stringify(method)}.`);
}

describe("connectGadgetAs", () => {
  it("hands the caller's identity to the gadget's onConnect()", async () => {
    let onConnect = vi.fn(async () => ({ session: true }));

    await connectGadgetAs({ onConnect }, USER);

    expect(onConnect).toHaveBeenCalledExactlyOnceWith(USER);
  });

  it("returns the capability onConnect() hands back", async () => {
    let session = { session: true };

    await expect(connectGadgetAs({ onConnect: async () => session }, USER)).resolves.toBe(session);
  });

  it("falls back to the bare facet for a gadget with no onConnect()", async () => {
    let facet = { onConnect: async () => { throw notImplemented(); } };

    await expect(connectGadgetAs(facet, USER)).resolves.toBeNull();
  });

  // A gadget may implement onConnect() purely to record who showed up, keeping the main Durable
  // Object as the client's stub.
  it.each([undefined, null])("falls back to the bare facet when onConnect() returns %s",
      async (returned) => {
    await expect(connectGadgetAs({ onConnect: async () => returned }, USER)).resolves.toBeNull();
  });

  // The security-relevant case: a gadget that gates access in onConnect() must not degrade to an
  // unrestricted stub because its own code threw.
  it("propagates an error thrown inside the gadget's onConnect()", async () => {
    let boom = new Error("gadget blew up");

    await expect(connectGadgetAs({ onConnect: async () => { throw boom; } }, USER))
        .rejects.toBe(boom);
  });

  // The narrow escape hatch must stay narrow: a TypeError that merely looks similar is a real
  // failure inside the gadget, not a missing method.
  it.each([
    ["a TypeError from the gadget's own code", new TypeError("foo is not a function")],
    ["a not-implemented report for a different method", notImplemented("getItems")],
    ["a non-TypeError with the same message", new Error(notImplemented().message)],
  ])("propagates %s", async (_name, err) => {
    await expect(connectGadgetAs({ onConnect: async () => { throw err; } }, USER)).rejects.toBe(err);
  });
});
