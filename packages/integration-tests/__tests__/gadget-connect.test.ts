// End-to-end tests for the Gadget `onConnect(user)` handshake.
//
// A Gadget that defines onConnect() is handed the caller's identity by the platform and returns the
// capability that connection may use. Unit tests cover the decision table; these cover the two
// things only a real runtime can prove:
//
//   1. A Gadget with no onConnect() still works. The fallback hinges on matching workerd's
//      not-implemented message exactly (see isGadgetConnectNotImplemented), so a runtime that
//      rephrases it would break every pre-existing Gadget -- loudly, here, rather than in
//      production.
//   2. The object onConnect() returns really does become the client's stub across the RPC boundary,
//      and a method left off it is genuinely unreachable rather than merely hidden.
//
// Nothing is stubbed but the network: the real workshop-backend runs under wrangler and these
// tests speak Cap'n Web over a WebSocket to /api exactly as the browser does.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RpcStub } from "capnweb";
import * as Y from "yjs";
import type {
  AuthenticatedApi, GadgetClient, GadgetUser, Overseer, PublicApi,
} from "@gadgets/workshop-shared/api";
import {
  startHarness, TEST_GATEKEEPER_BINDING, TEST_GATEKEEPER_DIR, type Harness,
} from "../src/harness.js";
import { connect, nextUsernames, signUp } from "../src/rpc-client.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";

let harness: Harness;
let interceptor: NetworkInterceptor;

beforeAll(async () => {
  interceptor = new NetworkInterceptor();
  interceptor.install();
  // Unlike every other suite here, these tests actually run gadget code, so the Worker Loader the
  // shared config drops has to come back.
  harness = await startHarness({
    gatekeepers: [{ binding: TEST_GATEKEEPER_BINDING, dir: TEST_GATEKEEPER_DIR }],
    patchWorkshop: config => { config.worker_loaders = [{ binding: "LOADER" }]; },
  });
});

afterAll(async () => {
  const unmocked = interceptor.getUnmockedCalls();
  await harness?.server.close();
  interceptor.uninstall();
  interceptor.reset();
  expect(unmocked).toEqual([]);
});

async function withSession<T>(body: (api: RpcStub<PublicApi>) => Promise<T>): Promise<T> {
  const publicApi = connect(harness.url);
  try {
    return await body(publicApi);
  } finally {
    publicApi[Symbol.dispose]();
  }
}

// A Gadget whose privileged method exists only on the capability handed to its owner. `whoami`
// echoes the identity back so the tests can assert what the platform actually passed in.
const IDENTITY_AWARE_SERVER = `
import { DurableObject, RpcTarget } from "cloudflare:workers";

export class Gadget extends DurableObject {
  onConnect(user) {
    return user.isOwner ? new AdminSession(user) : new ViewerSession(user);
  }
}

class ViewerSession extends RpcTarget {
  constructor(user) { super(); this.user = user; }
  whoami() { return this.user; }
}

class AdminSession extends ViewerSession {
  adminOnly() { return "secret"; }
}
`;

// No onConnect() at all: every Gadget written before the handshake existed looks like this.
const LEGACY_SERVER = `
import { DurableObject } from "cloudflare:workers";

export class Gadget extends DurableObject {
  greet(name) { return \`Hello, \${name}!\`; }
}
`;

/**
 * Write `server.js` into a gadget the way the editor does: a Yjs update against the gadget's file
 * map. The default gadget's files live at the document root (`gadgetRootName()` returns "" for it),
 * so the map name depends on which gadget this is.
 */
async function writeServerCode(
    overseer: RpcStub<Overseer>, gadgetId: number, source: string): Promise<void> {
  const { defaultGadgetId } = await overseer.getMetadata();
  const doc = new Y.Doc();
  const text = new Y.Text();
  text.insert(0, source);
  doc.getMap<Y.Text>(defaultGadgetId === gadgetId ? "" : `${gadgetId}`).set("server.js", text);
  await overseer.updateCode(Y.encodeStateAsUpdateV2(doc));
}

/**
 * Stand up a workspace owned by `username` holding one gadget running `source`.
 *
 * The two ids are different things and easy to mix up: `workspaceId` is the Overseer Durable
 * Object's id, which openGadget() takes, while `workpieceId` numbers the gadget within that
 * workspace and is what getGadget() takes.
 */
async function gadgetRunning(publicApi: RpcStub<PublicApi>, username: string, source: string)
    : Promise<{
      api: RpcStub<AuthenticatedApi>; overseer: RpcStub<Overseer>;
      workspaceId: string; workpieceId: number;
    }> {
  const api = await signUp(publicApi, username);
  const overseer = await api.newGadget();
  using gadget = await overseer.createGadget("Identity Test", undefined, "TEST_GADGET");
  const workpieceId = await gadget.getId();
  await writeServerCode(overseer, workpieceId, source);
  const { id: workspaceId } = await overseer.getMetadata();
  return { api, overseer, workspaceId, workpieceId };
}

/**
 * The fixture gadgets' RPC surface. `connectToGadget()` is declared as an opaque stub -- the
 * platform cannot know what any given gadget exposes -- so tests state what their own fixture
 * offers. Every method the gadget refuses is still declared here: the point of two of these tests
 * is that calling one fails at runtime, which requires it to typecheck.
 */
type GadgetSession = {
  whoami(): Promise<GadgetUser>;
  adminOnly(): Promise<string>;
  greet(name: string): Promise<string>;
  [Symbol.dispose](): void;
};

async function connectAsSession(gadget: RpcStub<GadgetClient>): Promise<GadgetSession> {
  return await gadget.connectToGadget() as unknown as GadgetSession;
}

describe("gadget onConnect() handshake", () => {
  it.concurrent("hands the owner a verified identity", async () => {
    await withSession(async publicApi => {
      const [alice] = nextUsernames("connectowner");
      const { api, overseer, workpieceId } =
          await gadgetRunning(publicApi, alice, IDENTITY_AWARE_SERVER);
      using _api = api;
      using workspace = overseer;

      using gadget = await workspace.getGadget(workpieceId);
      using session = await connectAsSession(gadget);

      await expect(session.whoami()).resolves.toEqual({
        id: alice,
        name: alice,
        role: "build",
        isOwner: true,
      });
      await expect(session.adminOnly()).resolves.toBe("secret");
    });
  });

  it.concurrent("reports a use-only collaborator's role, and withholds the owner's capability",
      async () => {
    await withSession(async publicApi => {
      const [alice, bob] = nextUsernames("connectowner2", "connectviewer");
      const { api, overseer, workspaceId, workpieceId } =
          await gadgetRunning(publicApi, alice, IDENTITY_AWARE_SERVER);
      using _ownerApi = api;
      using ownerWorkspace = overseer;

      using bobApi = await signUp(publicApi, bob);
      if (!await ownerWorkspace.addCollaborator(bob, "use")) {
        throw new Error(`Failed to share the gadget with ${bob}`);
      }

      using bobWorkspace = await bobApi.openGadget(workspaceId);
      using gadget = await bobWorkspace.getGadget(workpieceId);
      using session = await connectAsSession(gadget);

      await expect(session.whoami()).resolves.toEqual({
        id: bob,
        name: bob,
        role: "use",
        isOwner: false,
      });

      // Not merely hidden in the UI: adminOnly() is absent from the capability Bob was handed, so
      // calling it directly over RPC -- which any collaborator can do -- fails.
      await expect(session.adminOnly()).rejects.toThrow();
    });
  });

  it.concurrent("leaves a gadget with no onConnect() reachable as before", async () => {
    await withSession(async publicApi => {
      const [carol] = nextUsernames("connectlegacy");
      const { api, overseer, workpieceId } =
          await gadgetRunning(publicApi, carol, LEGACY_SERVER);
      using _api = api;
      using workspace = overseer;

      using gadget = await workspace.getGadget(workpieceId);
      using stub = await connectAsSession(gadget);

      await expect(stub.greet("World")).resolves.toBe("Hello, World!");
    });
  });
});
