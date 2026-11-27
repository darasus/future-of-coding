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

/** The gap between several rows arriving or leaving at once. */
const ROW_STAGGER_MS = 60

/**
 * Runs `after` when the element's own animation has finished. The stylesheet
 * decides how long that is; the timer is only for the case where no animation
 * ran at all, such as a window that is hidden.
 */
const whenAnimated = (element: HTMLElement, after: () => void) => {
  let done = false
  const finish = () => {
    if (done) return
    done = true
    element.removeEventListener("animationend", ended)
    after()
  }
  const ended = (event: AnimationEvent) => {
    if (event.target === element) finish()
  }
  element.addEventListener("animationend", ended)
  setTimeout(finish, 6000)
}

/**
 * Animates the list of threads as threads come and go. The list itself is
 * rendered from data and simply has a row more or a row fewer, so this watches
 * the element and supplies the motion in between, one thing after another:
 *
 * 1. A row that leaves is gone from the list at once, so a copy of it is laid
 *    over the place it was and erased by a block of lit lamps. The rows around
 *    it stay exactly where they were while that happens.
 * 2. Then every row that stays slides from where it was to where it is now:
 *    closing the gap a deletion left, opening one for an arrival, or carrying
 *    a row to its new place when the order changes.
 * 3. Last, a row that arrives is marked `data-arriving`, which the stylesheet
 *    prints into the gap that has opened for it.
 *
 * Rows that are there when the list first appears are simply there.
 */
const watchRows = (list: HTMLElement): () => void => {
  const still = matchMedia("(prefers-reduced-motion: reduce)")
  let places = new Map<Element, DOMRect>()
  /** The part of the window the list fills. It grows and shrinks with its rows. */
  let frame = list.getBoundingClientRect()
  const measure = () => {
    places = new Map([...list.children].map((row) => [row, row.getBoundingClientRect()]))
    frame = list.getBoundingClientRect()
  }
  const within = (place: DOMRect, bounds: DOMRect) => place.bottom > bounds.top && place.top < bounds.bottom
  /** How many deletions are still holding the list at its earlier height. */
  let holding = 0

  /** Copies of deleted rows live outside the list, where nothing re-renders them. */
  const ghosts = (): HTMLElement => {
    const found = document.querySelector<HTMLElement>(".row-ghosts")
    if (found !== null) return found
    const layer = document.createElement("div")
    layer.className = "row-ghosts"
    layer.setAttribute("aria-hidden", "true")
    document.body.append(layer)
    return layer
  }

  const erase = (row: HTMLElement, place: DOMRect, order: number) => {
    const ghost = row.cloneNode(true) as HTMLElement
    ghost.className = "row-ghost"
    ghost.removeAttribute("data-arriving")
    // A copy must not claim the name its original morphs under.
    for (const part of ghost.querySelectorAll<HTMLElement>("[style]")) part.style.viewTransitionName = "none"
    ghost.style.cssText = `left:${place.left}px;top:${place.top}px;width:${place.width}px;height:${place.height}px;` +
      `animation-delay:${order * ROW_STAGGER_MS}ms`
    ghosts().append(ghost)
    whenAnimated(ghost, () => ghost.remove())
  }

  const arrive = (row: HTMLElement, order: number, wait: number) => {
    row.style.animationDelay = `${wait + order * ROW_STAGGER_MS}ms`
    row.dataset.arriving = ""
    whenAnimated(row, () => {
      delete row.dataset.arriving
      row.style.animationDelay = ""
    })
  }

  const observer = new MutationObserver((records) => {
    const before = places
    const frameBefore = frame
    const added = new Set<HTMLElement>()
    const removed = new Set<HTMLElement>()
    for (const record of records) {
      for (const node of record.addedNodes) if (node instanceof HTMLElement) added.add(node)
      for (const node of record.removedNodes) if (node instanceof HTMLElement) removed.add(node)
    }
    // A row that was only moved shows up as both. What counts is where it ended up.
    const arrived = [...added].filter((row) => row.isConnected && !before.has(row))
    const left = [...removed].filter((row) => !row.isConnected)
    measure()

    const styles = getComputedStyle(list)
    const time = (name: string, fallback: number) => Number.parseFloat(styles.getPropertyValue(name)) || fallback
    const sweep = time("--print", 520)
    const glide = time("--morph", 440)

    // First, what was deleted is erased where it stood.
    let erased = 0
    for (const row of left) {
      // Where it was, in the list as it was: the list has already closed up.
      const place = before.get(row)
      if (place !== undefined && within(place, frameBefore)) erase(row, place, erased++)
    }
    const erasing = still.matches || erased === 0 ? 0 : sweep + (erased - 1) * ROW_STAGGER_MS

    // Then the rows that stay move to their new places. Until the erasing is
    // done they are held where they were.
    const moves = still.matches ? [] : [...places].flatMap(([row, place]) => {
      const was = before.get(row)
      if (was === undefined) return []
      const shift = was.top - place.top
      return Math.abs(shift) < 1 || (!within(was, frameBefore) && !within(place, frame)) ? [] : [{ row, shift }]
    })
    const easing = styles.getPropertyValue("--ease-drawer").trim() || "ease-out"
    for (const { row, shift } of moves) {
      row.animate(
        [{ transform: `translateY(${shift}px)` }, { transform: "none" }],
        { duration: glide, easing, delay: erasing, fill: "backwards" }
      )
    }
    // Rows held in their old places need the list's old height, or the lowest
    // of them would be cut off by a list that has already shrunk.
    if (moves.length > 0 && erasing > 0 && frame.height < frameBefore.height) {
      list.style.minHeight = `${frameBefore.height}px`
      holding++
      setTimeout(() => {
        if (--holding > 0) return
        list.style.minHeight = ""
        if (list.isConnected) measure()
      }, erasing + glide)
    }

    // Last, a new row is printed into the gap, once the gap is mostly open.
    const opened = moves.length > 0 ? erasing + glide * 0.7 : erasing
    let order = 0
    for (const row of arrived) arrive(row, order++, still.matches ? 0 : opened)
  })

  observer.observe(list, { childList: true })
  measure()
  list.addEventListener("scroll", measure, { passive: true })
  window.addEventListener("resize", measure)
  return () => {
    observer.disconnect()
    list.removeEventListener("scroll", measure)
    window.removeEventListener("resize", measure)
  }
}

/**
 * Gives a list its arrivals, departures and reordering. See `watchRows`.
 * `list` only names it and never changes: the watcher has to live as long as
 * the list does, and be there when a row is taken out of it.
 */
export const RowMotion = Mount.makeStream(
  "RowMotion",
  { args: { list: Schema.String } },
  (node: HTMLElement, _args, changes) =>
    Stream.unwrap(
      Effect.gen(function*() {
        yield* Effect.acquireRelease(Effect.sync(() => watchRows(node)), (stop) => Effect.sync(stop))
        return changes.pipe(Stream.drain)
      })
    )
)
