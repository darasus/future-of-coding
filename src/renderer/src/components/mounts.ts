import { Component, Mount } from "@effect/ui"
import { Effect, Schema, Stream } from "effect"

/**
 * Keeps a scrolling transcript at its end while new content arrives, unless
 * the reader has scrolled up to look at something earlier.
 */
export const FollowEnd = Mount.makeStream(
  "FollowEnd",
  { args: { revision: Schema.Number } },
  (node: HTMLElement, _args, changes) =>
    Stream.unwrap(
      Effect.gen(function*() {
        let following = true
        // What the transcript opens with is simply there. Marking the node a
        // moment later lets CSS animate only what arrives afterwards.
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            node.dataset.ready = ""
          })
        )
        const onScroll = () => {
          following = node.scrollHeight - node.scrollTop - node.clientHeight < 96
        }
        yield* Effect.acquireRelease(
          Effect.sync(() => node.addEventListener("scroll", onScroll, { passive: true })),
          () => Effect.sync(() => node.removeEventListener("scroll", onScroll))
        )
        return changes.pipe(
          Stream.tap(() =>
            Effect.sync(() => {
              if (following) node.scrollTop = node.scrollHeight
            })
          ),
          Stream.drain
        )
      })
    )
)

/**
 * Sets `data-ready` on an element a moment after it mounts. CSS keys entrance
 * animations on it, so content that arrives with the element is not animated
 * a second time and only later arrivals are.
 */
export const MarkReady = Mount.make(
  "MarkReady",
  { args: { after: Schema.Number } },
  (node: HTMLElement, { after }) =>
    Effect.sleep(after).pipe(
      Effect.andThen(Effect.sync(() => {
        node.dataset.ready = ""
      })),
      Effect.as(Component.noop)
    )
)
