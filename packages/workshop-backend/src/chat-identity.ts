import type { AiChatAuthorInfo, AiChatMessage } from "@gadgets/workshop-shared/api";

// Who the agent is talking to.
//
// Every chat message carries an author, but replay hands the model the message *content* only, and
// the system prompt described the workspace without ever naming the person driving it -- so an agent
// asked "who am I?" had nothing to answer from, and would either guess or ask the user to introduce
// themselves.
//
// The identity is already at hand one frame up: a turn's `initiator` is the profile of whoever sent
// the message being answered, resolved by the Overseer from that caller's authenticated session (see
// sendChatMessage) and never supplied by the client. So it can be stated as fact in the prompt.
//
// A chat is not necessarily a two-party conversation: `build` collaborators share the workspace's
// AI chat (see docs/sharing.md), and a Gadget can post prompts programmatically through a spawner.
// The initiator names only the sender of the current message, so once a chat has more than one
// participant, the individual messages have to say who wrote them too.

// Identifies a participant across messages. Author type is part of the key because a "gadget"
// author's `id` is the *owner's* profile id (see AiChatAuthorInfo): two Gadgets owned by the same
// person share an id, and a Gadget shares its owner's id with that owner's own messages.
function participantKey(author: AiChatAuthorInfo): string {
  return `${author.type}:${author.id}`;
}

/**
 * The distinct non-agent authors who have written in the chat, in first-appearance order. Note this
 * sees only the messages replay was given: after compaction the earlier participants live on in the
 * summary, not here, so a chat can drop back to a single participant.
 */
export function listChatParticipants(chatMessages: AiChatMessage[]): AiChatAuthorInfo[] {
  let participants = new Map<string, AiChatAuthorInfo>();
  for (let msg of chatMessages) {
    if (msg.type !== "message" || msg.author.type === "agent") continue;
    let key = participantKey(msg.author);
    if (!participants.has(key)) participants.set(key, msg.author);
  }
  return [...participants.values()];
}

/**
 * Name the author of one message, for chats with more than one participant. Bracketed rather than
 * "Name: text" so it stays distinguishable from a message that happens to open with a colon.
 *
 * The prefix must be non-empty even for empty text: an image-only message still needs its author,
 * and the caller relies on the result being truthy to decide whether to emit a text part at all.
 */
export function attributeChatMessage(text: string, author: AiChatAuthorInfo): string {
  return text ? `[${author.name}] ${text}` : `[${author.name}]`;
}

/**
 * The system-prompt section naming who the agent is talking to.
 *
 * `attributedParticipants` is the chat's participant list when replay is prefixing messages with
 * their author (i.e. when there is more than one), and undefined when it isn't -- the prompt has to
 * describe the format the model is actually seeing, or the brackets read as part of the user's text.
 *
 * This belongs in the dynamic system-prompt slot: in a shared chat the initiator changes from turn
 * to turn as different collaborators write.
 */
export function formatChatIdentityPrompt(
    initiator: AiChatAuthorInfo,
    attributedParticipants?: AiChatAuthorInfo[]): string {
  let lines: string[] = ["# Who you are talking to", ""];

  switch (initiator.type) {
    case "user":
      lines.push(
          `You are talking to **${initiator.name}** (\`${initiator.id}\`). The platform fills this ` +
          `in from the sender's authenticated session on every turn, so you can state it as fact: ` +
          `answer questions about who the user is directly, address them by name when it reads ` +
          `naturally, and use the id when you need a stable key for per-user data. Never ask the ` +
          `user to tell you who they are.`);
      break;

    case "gadget":
      // A spawner prompt: `name` is the Gadget's title and `id` is its owner's profile id.
      lines.push(
          `The message you are answering was sent programmatically by the Gadget ` +
          `**${initiator.name}**, on behalf of its owner (\`${initiator.id}\`). Nobody typed it, ` +
          `and there may be no human reading your reply as you write it.`);
      break;

    case "agent":
      // A model profile never initiates a turn -- turns start from a person, a Gadget, or a resumed
      // record of one of those. Say nothing rather than assert an identity we don't have.
      return "";

    default:
      initiator.type satisfies never;
      return "";
  }

  if (attributedParticipants && attributedParticipants.length > 1) {
    lines.push(
        "",
        `More than one participant has written in this chat, so each of their messages is ` +
        `prefixed with the author's name in brackets, e.g. \`[${attributedParticipants[0].name}] ` +
        `<message>\`. The prefix is added by the platform and is not part of what they wrote. ` +
        `Participants so far: ` +
        `${attributedParticipants.map(p => `${p.name} (\`${p.id}\`)`).join(", ")}. Requests belong ` +
        `to whoever made them; the identity above is the sender of the message you are answering ` +
        `now.`);
  }

  return lines.join("\n");
}
