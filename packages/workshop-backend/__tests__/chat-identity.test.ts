import { describe, expect, it } from "vitest";
import type { AiChatAuthorInfo, AiChatMessage } from "@gadgets/workshop-shared/api";
import {
  attributeChatMessage, formatChatIdentityPrompt, listChatParticipants,
} from "../src/chat-identity.js";

const ALICE: AiChatAuthorInfo = {type: "user", id: "alice@example.com", name: "Alice Ng"};
const BOB: AiChatAuthorInfo = {type: "user", id: "bob@example.com", name: "Bob Ito"};
const CLAUDE: AiChatAuthorInfo = {type: "agent", id: "claude-opus-5", name: "Claude"};
// A spawner prompt: the id is the Gadget owner's profile id, the name is the Gadget's title.
const TRACKER: AiChatAuthorInfo = {type: "gadget", id: "alice@example.com", name: "Expense Tracker"};

let nextSequence = 0;

function message(author: AiChatAuthorInfo, text: string): AiChatMessage {
  return {
    chatId: 1,
    sequence: ++nextSequence,
    timestamp: new Date(0),
    author,
    type: "message",
    message: text,
  };
}

function nonMessage(author: AiChatAuthorInfo): AiChatMessage {
  return {
    chatId: 1,
    sequence: ++nextSequence,
    timestamp: new Date(0),
    author,
    type: "agentCallback",
    methodName: "onTick",
    argsSummary: "{}",
  };
}

describe("listChatParticipants", () => {
  it("returns the distinct non-agent authors in first-appearance order", () => {
    expect(listChatParticipants([
      message(ALICE, "hi"),
      message(CLAUDE, "hello"),
      message(BOB, "hey"),
      message(ALICE, "still me"),
    ])).toEqual([ALICE, BOB]);
  });

  it("ignores agents, so a solo chat stays solo", () => {
    expect(listChatParticipants([
      message(ALICE, "hi"), message(CLAUDE, "hello"), message(ALICE, "thanks"),
    ])).toEqual([ALICE]);
  });

  it("counts a Gadget separately from its owner", () => {
    // Both carry id "alice@example.com" -- keying on the id alone would merge them.
    expect(listChatParticipants([message(TRACKER, "run the monthly report"), message(ALICE, "wait")]))
        .toEqual([TRACKER, ALICE]);
  });

  it("ignores messages that are not chat messages", () => {
    // A hook delivery or callback is not somebody writing in the chat, so it must not make a solo
    // chat look shared.
    expect(listChatParticipants([message(ALICE, "hi"), nonMessage(TRACKER)])).toEqual([ALICE]);
  });

  it("handles an empty log", () => {
    expect(listChatParticipants([])).toEqual([]);
  });
});

describe("attributeChatMessage", () => {
  it("prefixes the author's name", () => {
    expect(attributeChatMessage("ship it", BOB)).toBe("[Bob Ito] ship it");
  });

  it("stays non-empty for a message with no text", () => {
    // An image-only message still needs an author, and the caller uses truthiness to decide
    // whether to emit a text part at all.
    expect(attributeChatMessage("", BOB)).toBe("[Bob Ito]");
  });
});

describe("formatChatIdentityPrompt", () => {
  it("names the human driving the turn, with their id", () => {
    let prompt = formatChatIdentityPrompt(ALICE);
    expect(prompt).toContain("Alice Ng");
    expect(prompt).toContain("alice@example.com");
    expect(prompt).toContain("Never ask the user to tell you who they are.");
  });

  it("says a Gadget sent the message when the turn was started programmatically", () => {
    let prompt = formatChatIdentityPrompt(TRACKER);
    expect(prompt).toContain("Expense Tracker");
    expect(prompt).toContain("alice@example.com");
    expect(prompt).not.toContain("You are talking to");
  });

  it("asserts no identity when a model profile is somehow the initiator", () => {
    expect(formatChatIdentityPrompt(CLAUDE)).toBe("");
  });

  it("omits the attribution note for a solo chat", () => {
    let prompt = formatChatIdentityPrompt(ALICE, undefined);
    expect(prompt).not.toContain("brackets");
    // A one-element list means replay is not prefixing anything, so the note would be a lie.
    expect(formatChatIdentityPrompt(ALICE, [ALICE])).toBe(prompt);
  });

  it("explains the bracketed prefixes and lists the participants when a chat is shared", () => {
    let prompt = formatChatIdentityPrompt(BOB, [ALICE, BOB]);
    expect(prompt).toContain("You are talking to **Bob Ito**");
    expect(prompt).toContain("[Alice Ng] <message>");
    expect(prompt).toContain("Alice Ng (`alice@example.com`), Bob Ito (`bob@example.com`)");
  });
});
