/**
 * Weixin message → Trigger mapping for the `weixin` Source kind.
 *
 * The wire shape below is the one `ilink/bot/getupdates` actually returns. It was
 * read from live traffic, not assumed: every field name here (`from_user_id`,
 * `message_id`, `item_list`, …) is what the provider sends. A change there is a
 * protocol change this module has to follow.
 *
 * One message is one Trigger; its Thread is the conversation it arrived in; the
 * sender's `from_user_id` becomes the actor id the Policy's allowed list names.
 */
import { z } from 'zod'
import { key, type Trigger } from '../core/index.ts'

export const SOURCE = 'weixin'

/** Appends the source prefix to a Weixin-native id to form a stable Trigger id. */
export const weixinTriggerId = (messageId: string): string => key(SOURCE, messageId)

/** Thread id: one conversation (direct chat or group) is one Thread. */
export const weixinThreadId = (conversationId: string): string => conversationId

/** One entry of `item_list`; `type: 1` carries text in `text_item.text`. */
const ItemSchema = z.looseObject({
  type: z.number().optional(),
  text_item: z.looseObject({ text: z.string() }).optional(),
})

/**
 * One message as `ilink/bot/getupdates` prints it.
 *
 * Loose for fields this Source does not read: the provider adds fields over time and
 * a strict schema would reject otherwise usable messages. Only what the Source uses
 * is required.
 */
export const WeixinMessageSchema = z.looseObject({
  message_id: z.union([z.string().min(1), z.number()]),
  from_user_id: z.string().min(1),
  to_user_id: z.string().optional(),
  session_id: z.string().optional(),
  group_id: z.string().optional(),
  message_type: z.union([z.number(), z.string()]).optional(),
  message_state: z.union([z.number(), z.string()]).optional(),
  create_time_ms: z.union([z.number(), z.string()]).optional(),
  item_list: z.array(z.unknown()).default([]),
})
export type WeixinMessage = z.infer<typeof WeixinMessageSchema>

/** The answer of `ilink/bot/getupdates`; `msgs` stays unknown until each item is validated. */
export const WeixinUpdatesSchema = z.looseObject({
  ret: z.union([z.number(), z.string()]).optional(),
  errcode: z.union([z.number(), z.string()]).optional(),
  msgs: z.array(z.unknown()).default([]),
  get_updates_buf: z.string().optional(),
})

/** Concatenates the text of every text item; other item kinds contribute a short marker. */
export function weixinText(message: WeixinMessage): string {
  const parts: string[] = []
  for (const raw of message.item_list) {
    const item = ItemSchema.safeParse(raw)
    if (!item.success) continue
    if (item.data.text_item?.text) parts.push(item.data.text_item.text)
    else if (item.data.type !== undefined) parts.push(`[${item.data.type === 3 ? 'image' : `item:${item.data.type}`}]`)
  }
  return parts.join('\n').trim()
}

/** `create_time_ms` is epoch milliseconds; a missing or unparseable value falls back to now. */
export function weixinTime(value: string | number | undefined, now: number = Date.now()): string {
  const ms = Number(value)
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : new Date(now).toISOString()
}

/** The message id as a string, since the provider sometimes sends it as a number. */
export const weixinMessageId = (message: WeixinMessage): string => String(message.message_id)

/** The conversation id of a message: the group id for a group message, else the peer's user id. */
export function weixinConversation(message: WeixinMessage): string {
  return message.group_id && message.group_id.length > 0 ? message.group_id : message.from_user_id
}

/**
 * Builds the Trigger for one inbound Weixin message.
 *
 * Returns `undefined` for the bot's own messages: a Source never produces a Trigger
 * for its own output, and accepting one twice would create a Ticket for the agent's
 * own reply. `self` is the bot's own id (`to_user_id` on messages it receives).
 *
 * A direct message is addressed to the agent; a group message is not, and the
 * Source's receiving scope decides whether it is listened to at all.
 */
export function weixinTrigger(message: WeixinMessage, self: string, options: { direct: boolean }): Trigger | undefined {
  if (message.from_user_id === self) return undefined
  const conversation = weixinConversation(message)
  const thread = weixinThreadId(conversation)
  return {
    id: weixinTriggerId(weixinMessageId(message)),
    source: SOURCE,
    threads: [{ source: SOURCE, id: thread }],
    actor: { source: SOURCE, id: message.from_user_id },
    human: true,
    ...(options.direct ? { addressed: 'direct' as const } : {}),
    at: weixinTime(message.create_time_ms),
    text: weixinText(message),
    channel: {
      source: SOURCE,
      thread: `${SOURCE}:${thread}`,
      address: { conversation, ...(message.session_id ? { sessionId: message.session_id } : {}) },
    },
    meta: {
      conversation,
      messageId: weixinMessageId(message),
      // `direct` is what the Source's scope reads; it must survive into the stored Mandate basis.
      direct: options.direct,
      ...(message.session_id ? { sessionId: message.session_id } : {}),
      ...(message.group_id ? { groupId: message.group_id } : {}),
    },
  }
}
