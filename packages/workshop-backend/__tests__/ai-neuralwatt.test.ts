import { beforeEach, describe, expect, it } from "vitest";
import type { AiChatAuthorInfo, AiModelConfig } from "@gadgets/workshop-shared/api";
import { getModel, type ModelHandle } from "../src/ai-models.js";
import { GatewayModels, getAiGatewayConfig } from "../src/ai-gateway.js";
import { DEFAULT_ADMIN_CONFIG } from "../src/storage-schema/admin-settings-storage.js";

// Neuralwatt is absent from AI Gateway's provider catalog, so it is reached as an AI Gateway
// *custom provider*: a slug + base URL + stored key configured in the gateway, addressed by
// naming `custom-<slug>/<model>` in the model field of the unified /compat endpoint. These tests
// pin what is special about that route -- the model-field prefix, the stored key (so we send no
// provider Authorization), and the fact that only the platform gateway has the registration, so
// the BYOK user-gateway path is never taken. Same no-mocks approach as
// ai-models.test.ts: assertions read the handle's model descriptor and the request captured from
// an injected fetch stub.

const INITIATOR: AiChatAuthorInfo = { type: "user", id: "user-123", name: "User" };

const NEURALWATT_CONFIG: AiModelConfig = {
  provider: "neuralwatt",
  model: "mimo-v2.6-pro",
  apiToken: "",
};

const GATEWAY_COMPAT_URL =
    "https://gateway.ai.cloudflare.com/v1/gateway-account-id/cloudflare-os/compat";

function env(overrides: Partial<Cloudflare.Env> = {}): Cloudflare.Env {
  return {
    CF_AI_GATEWAY: "cloudflare-os",
    CF_AI_GATEWAY_ACCOUNT_ID: "gateway-account-id",
    CF_AI_GATEWAY_API_TOKEN: "gateway-token",
    CF_AI_GATEWAY_PROVIDERS: "neuralwatt",
    NEURALWATT_API_TOKEN: "nw-deployment-key",
    ...overrides,
  } as Cloudflare.Env;
}

// A deployment with no AI Gateway at all (local dev, or one that never enabled it): the only
// route on which Neuralwatt still uses its own endpoint and its own key.
function directEnv(overrides: Partial<Cloudflare.Env> = {}): Cloudflare.Env {
  return env({ CF_AI_GATEWAY: undefined, ...overrides });
}

// What the deployment actually looks like: WORKERS_AI bound, so the binding is the transport.
// `{}` stands in for the binding because every test here injects its own fetch, which overrides
// the handle's binding fetch.
function bindingEnv(overrides: Partial<Cloudflare.Env> = {}): Cloudflare.Env {
  return env({ WORKERS_AI: {} as Ai, ...overrides });
}

type CapturedRequest = { url: string; headers: Headers; body: string };

const capturedRequests: CapturedRequest[] = [];

const fetchStub = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const request = new Request(input as RequestInfo, init);
  capturedRequests.push({ url: request.url, headers: request.headers, body: await request.text() });
  return Response.json({ error: { type: "bad_request", message: "stubbed" } }, { status: 400 });
}) as typeof fetch;

async function captureRequest(handle: ModelHandle): Promise<CapturedRequest> {
  const stream = await handle.stream(handle.model, {
    messages: [{ role: "user", content: "hello", timestamp: 0 }],
  }, { fetch: fetchStub, maxRetries: 0 });
  const message = await stream.result();
  expect(message.stopReason).toBe("error");
  expect(capturedRequests.length).toBeGreaterThan(0);
  return capturedRequests[0];
}

describe("neuralwatt routing", () => {
  beforeEach(() => {
    capturedRequests.length = 0;
  });

  it("routes through the platform gateway's custom provider on /compat", async () => {
    const handle = getModel(env(), NEURALWATT_CONFIG, INITIATOR, {
      metadata: { source: "chat", chatId: 7 },
    });

    expect(handle.model.baseUrl).toBe(GATEWAY_COMPAT_URL);
    // The custom provider is named in the model field, which is what pi puts on the wire; the
    // display name stays bare so the UI still shows the plain model id.
    expect(handle.model.id).toBe("custom-neuralwatt/mimo-v2.6-pro");
    expect(handle.model.name).toBe("mimo-v2.6-pro");
    // A gateway request means a gateway log, hence a cost route to record against.
    expect(handle.aiGatewayLogRoute).toEqual({
      gateway: "cloudflare-os",
      accountId: "gateway-account-id",
      apiToken: "gateway-token",
    });

    const request = await captureRequest(handle);
    expect(request.url).toBe(`${GATEWAY_COMPAT_URL}/chat/completions`);
    expect(JSON.parse(request.body).model).toBe("custom-neuralwatt/mimo-v2.6-pro");
    // The Neuralwatt key is stored on the custom provider in the Gateway, so the request carries
    // gateway auth only -- a provider Authorization header would take precedence over the
    // stored key and defeat the point.
    expect(request.headers.get("cf-aig-authorization")).toBe("Bearer gateway-token");
    expect(request.headers.get("authorization")).toBeNull();
    expect(request.headers.get("x-api-key")).toBeNull();
    expect(JSON.parse(request.headers.get("cf-aig-metadata")!))
        .toEqual({ user: "user-123", source: "chat", chatId: 7 });
  });

  it("ignores the model's own key and apiUrl under gateway mode", async () => {
    // Same rule as every other provider in gateway mode: env owns the routing. Neuralwatt used to
    // be the exception (its config key won), so this pins the change.
    const handle = getModel(
        env(),
        { ...NEURALWATT_CONFIG, apiToken: "nw-user-key", apiUrl: "https://proxy.example.com/v1" },
        INITIATOR, {});

    expect(handle.model.baseUrl).toBe(GATEWAY_COMPAT_URL);
    const request = await captureRequest(handle);
    expect(request.headers.get("authorization")).toBeNull();
    expect(request.url).not.toContain("proxy.example.com");
  });

  it("stays on the platform gateway when a user's own gateway is available", async () => {
    // Custom providers are per-gateway registrations: a connected user's auto-created "default"
    // gateway has no neuralwatt slug, so the BYOK path can't carry it. Neuralwatt therefore stays
    // funded by the stored key on the platform gateway.
    const handle = getModel(env(), NEURALWATT_CONFIG, INITIATOR, {
      userGateway: { accountId: "user-account-id", apiKey: "user-token" },
    });

    expect(handle.model.baseUrl).toBe(GATEWAY_COMPAT_URL);
    expect(handle.aiGatewayLogRoute).toMatchObject({ accountId: "gateway-account-id" });

    const request = await captureRequest(handle);
    expect(request.url).not.toContain("user-account-id");
    expect(request.headers.get("cf-aig-authorization")).toBe("Bearer gateway-token");
  });

  it("rides the Workers AI binding, as this deployment does", async () => {
    // The binding is the transport whenever it is bound, custom provider or not: the channel
    // carries whatever gateway path the base URL names, and pre-authenticates in-account, so the
    // request needs no gateway token. Binding-routed requests address the binding's own host,
    // which takes no account id -- that is the observable difference from the HTTPS root.
    const handle = getModel(
        bindingEnv(), NEURALWATT_CONFIG, INITIATOR, { metadata: { source: "chat", chatId: 7 } });

    expect(handle.model.baseUrl)
        .toBe("https://workers-binding.ai/ai-gateway/gateways/cloudflare-os/compat");
    expect(handle.model.id).toBe("custom-neuralwatt/mimo-v2.6-pro");
    // Same-account log reads need no account id or token over the binding.
    expect(handle.aiGatewayLogRoute).toEqual({ gateway: "cloudflare-os" });

    const request = await captureRequest(handle);
    expect(request.url)
        .toBe("https://workers-binding.ai/ai-gateway/gateways/cloudflare-os/compat/chat/completions");
    expect(JSON.parse(request.body).model).toBe("custom-neuralwatt/mimo-v2.6-pro");
    // The sentinel satisfies pi's "some auth must be present" check; the Gateway recognizes and
    // strips it rather than forwarding it as a provider key, so the stored key still applies.
    expect(request.headers.get("cf-aig-authorization")).toBe("Bearer cloudflare-gateway-binding");
    expect(request.headers.get("authorization")).toBeNull();
  });

  it("sends the system role, never the developer role", async () => {
    // Neuralwatt rejects `developer` with HTTP 400 and its catalog declares developer_role:false
    // on every model. pi picks this per-API default by sniffing the base URL -- which is now
    // gateway.ai.cloudflare.com, making the explicit compat flag even more load-bearing than it
    // was against api.neuralwatt.com. Asserted on the serialized request rather than on the flag,
    // so a change to either end fails here.
    const handle = getModel(env(), NEURALWATT_CONFIG, INITIATOR, {});
    const stream = await handle.stream(handle.model, {
      systemPrompt: "You are a careful assistant.",
      messages: [{ role: "user", content: "hello", timestamp: 0 }],
    }, { fetch: fetchStub, maxRetries: 0 });
    await stream.result();

    const roles = JSON.parse(capturedRequests[0].body).messages.map(m => m.role);
    expect(roles).toContain("system");
    expect(roles).not.toContain("developer");
  });

  it("omits request fields the endpoint silently ignores", async () => {
    const handle = getModel(env(), NEURALWATT_CONFIG, INITIATOR, {});
    const request = await captureRequest(handle);
    const body = JSON.parse(request.body);

    expect(body.store).toBeUndefined();
    expect(body.prompt_cache_retention).toBeUndefined();
  });

  it("uses the token-window metadata from SUGGESTED_MODELS", () => {
    const handle = getModel(env(), NEURALWATT_CONFIG, INITIATOR, {});
    expect(handle.model.contextWindow).toBe(1048560);
    expect(handle.model.maxTokens).toBe(393216);
    // Energy-billed, so a per-token cost would be fiction -- including through the Gateway, whose
    // log cost for an unpriced custom provider falls back to this estimate.
    expect(handle.model.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });
});

describe("neuralwatt without an AI Gateway", () => {
  beforeEach(() => {
    capturedRequests.length = 0;
  });

  it("calls Neuralwatt directly with the deployment key", async () => {
    const handle = getModel(directEnv(), NEURALWATT_CONFIG, INITIATOR, {});

    expect(handle.model.baseUrl).toBe("https://api.neuralwatt.com/v1");
    expect(handle.model.id).toBe("mimo-v2.6-pro");
    // No Gateway request means no Gateway log, so there is no cost route to record against.
    expect(handle.aiGatewayLogRoute).toBeUndefined();

    const request = await captureRequest(handle);
    expect(request.url.startsWith("https://api.neuralwatt.com/v1")).toBe(true);
    expect(request.headers.get("authorization")).toBe("Bearer nw-deployment-key");
    expect(request.headers.get("cf-aig-authorization")).toBeNull();
  });

  it("prefers a key stored on the model over the deployment key", async () => {
    const handle = getModel(
        directEnv(), { ...NEURALWATT_CONFIG, apiToken: "nw-user-key" }, INITIATOR, {});

    const request = await captureRequest(handle);
    expect(request.headers.get("authorization")).toBe("Bearer nw-user-key");
  });

  it("honors an apiUrl override and strips its trailing slash", async () => {
    const handle = getModel(
        directEnv(), { ...NEURALWATT_CONFIG, apiUrl: "https://proxy.example.com/v1/" },
        INITIATOR, {});

    expect(handle.model.baseUrl).toBe("https://proxy.example.com/v1");
  });

  it("reports a usable error when no Neuralwatt key is available at all", () => {
    expect(() => getModel(
        directEnv({ NEURALWATT_API_TOKEN: undefined }), NEURALWATT_CONFIG, INITIATOR, {}))
      .toThrow(/NEURALWATT_API_TOKEN/);
  });
});

describe("AiGatewayConfig with neuralwatt enabled", () => {
  it("starts without a Neuralwatt key, which now lives in the Gateway", () => {
    expect(getAiGatewayConfig(env({ NEURALWATT_API_TOKEN: undefined }))!.providers)
        .toEqual(new Set(["neuralwatt"]));
  });

  it("needs no gateway token when the binding carries neuralwatt", () => {
    const config = getAiGatewayConfig(bindingEnv({ CF_AI_GATEWAY_API_TOKEN: undefined }))!;
    expect(config.apiToken).toBeUndefined();
    expect(config.bindingFor("neuralwatt")).toBeDefined();
  });

  it("still needs a transport of some kind", () => {
    expect(() => getAiGatewayConfig(env({ CF_AI_GATEWAY_API_TOKEN: undefined })))
        .toThrow(/needs a transport/);
  });

  it("advertises Neuralwatt models ahead of the other providers", () => {
    const config = getAiGatewayConfig(env({
      CF_AI_GATEWAY_PROVIDERS: "neuralwatt,anthropic",
    }))!;
    const models = new GatewayModels(config, DEFAULT_ADMIN_CONFIG);
    const ids = models.list("language").map(model => model.id);

    expect(ids[0]).toBe("mimo-v2.6-pro");
    expect(ids).toContain("claude-opus-5-5");
    expect(models.get("glm-5.3")?.provider).toBe("neuralwatt");
  });

  it("falls back to a Neuralwatt quick model when Workers AI is not enabled", () => {
    expect(getAiGatewayConfig(env())!.getQuickModelConfig()).toEqual({
      provider: "neuralwatt",
      model: "deepseek-v4-flash",
      apiToken: "",
    });
  });

  it("still prefers Workers AI for quick tasks when it is enabled", () => {
    const config = getAiGatewayConfig(env({
      CF_AI_GATEWAY_PROVIDERS: "neuralwatt,cloudflare",
    }))!;
    expect(config.getQuickModelConfig()?.provider).toBe("cloudflare");
  });

  it("skips quick-model work when no provider can serve it", () => {
    const config = getAiGatewayConfig(env({ CF_AI_GATEWAY_PROVIDERS: "anthropic" }))!;
    expect(config.getQuickModelConfig()).toBeUndefined();
  });
});
