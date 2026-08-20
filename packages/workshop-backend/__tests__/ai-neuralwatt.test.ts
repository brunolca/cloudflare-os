import { beforeEach, describe, expect, it } from "vitest";
import type { AiChatAuthorInfo, AiModelConfig } from "@gadgets/workshop-shared/api";
import { getModel, type ModelHandle } from "../src/ai-models.js";
import { getAiGatewayConfig } from "../src/ai-gateway.js";

// Neuralwatt is the one provider that is advertised through CF_AI_GATEWAY_PROVIDERS but never
// routed through AI Gateway (the Gateway has no neuralwatt provider). These tests pin that
// asymmetry down: gateway mode must not capture it, BYOK must not capture it, and it must carry
// its own key. Same no-mocks approach as ai-models.test.ts -- assertions read the handle's model
// descriptor and the request captured from an injected fetch stub.

const INITIATOR: AiChatAuthorInfo = { type: "user", id: "user-123", name: "User" };

const NEURALWATT_CONFIG: AiModelConfig = {
  provider: "neuralwatt",
  model: "kimi-k2.7-code",
  apiToken: "",
};

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

  it("calls Neuralwatt directly even while a platform gateway is configured", async () => {
    const handle = getModel(env(), NEURALWATT_CONFIG, INITIATOR, {
      metadata: { source: "chat", chatId: 7 },
    });

    expect(handle.model.baseUrl).toBe("https://api.neuralwatt.com/v1");
    // No Gateway request means no Gateway log, so there is no cost route to record against.
    expect(handle.aiGatewayLogRoute).toBeUndefined();

    const request = await captureRequest(handle);
    expect(request.url.startsWith("https://api.neuralwatt.com/v1")).toBe(true);
    expect(request.url).not.toContain("gateway.ai.cloudflare.com");
    expect(request.headers.get("authorization")).toBe("Bearer nw-deployment-key");
    expect(request.headers.get("cf-aig-authorization")).toBeNull();
  });

  it("bypasses the BYOK user-gateway path, which also cannot proxy Neuralwatt", async () => {
    const handle = getModel(env(), NEURALWATT_CONFIG, INITIATOR, {
      userGateway: { accountId: "user-account-id", apiKey: "user-token" },
    });

    expect(handle.model.baseUrl).toBe("https://api.neuralwatt.com/v1");
    const request = await captureRequest(handle);
    expect(request.headers.get("authorization")).toBe("Bearer nw-deployment-key");
  });

  it("prefers a key stored on the model over the deployment key", async () => {
    const handle = getModel(
        env(), { ...NEURALWATT_CONFIG, apiToken: "nw-user-key" }, INITIATOR, {});

    const request = await captureRequest(handle);
    expect(request.headers.get("authorization")).toBe("Bearer nw-user-key");
  });

  it("honors an apiUrl override and strips its trailing slash", async () => {
    const handle = getModel(
        env(), { ...NEURALWATT_CONFIG, apiUrl: "https://proxy.example.com/v1/" }, INITIATOR, {});

    expect(handle.model.baseUrl).toBe("https://proxy.example.com/v1");
  });

  it("reports a usable error when no Neuralwatt key is available at all", () => {
    expect(() => getModel(
        env({ NEURALWATT_API_TOKEN: undefined, CF_AI_GATEWAY_PROVIDERS: "anthropic" }),
        NEURALWATT_CONFIG, INITIATOR, {}))
      .toThrow(/NEURALWATT_API_TOKEN/);
  });

  it("sends the system role, never the developer role", async () => {
    // Neuralwatt rejects `developer` with HTTP 400 and its catalog declares developer_role:false
    // on every model. pi picks this per-API default by sniffing the base URL and has no rule for
    // api.neuralwatt.com, so the compat flag is the only thing keeping this correct. Asserted on
    // the serialized request rather than on the flag, so a change to either end fails here.
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
    expect(handle.model.contextWindow).toBe(262128);
    // Energy-billed, so a per-token cost would be fiction.
    expect(handle.model.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });
});

describe("AiGatewayConfig with neuralwatt enabled", () => {
  it("refuses to start when the Neuralwatt key is missing", () => {
    expect(() => getAiGatewayConfig(env({ NEURALWATT_API_TOKEN: undefined })))
      .toThrow(/NEURALWATT_API_TOKEN is required/);
  });

  it("advertises Neuralwatt models ahead of the other providers", () => {
    const config = getAiGatewayConfig(env({
      CF_AI_GATEWAY_PROVIDERS: "neuralwatt,anthropic",
    }))!;
    const ids = config.getModelList().map(model => model.id);

    expect(ids[0]).toBe("kimi-k2.7-code");
    expect(ids).toContain("claude-opus-5");
    expect(config.resolveModel("glm-5.2")?.config.provider).toBe("neuralwatt");
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
