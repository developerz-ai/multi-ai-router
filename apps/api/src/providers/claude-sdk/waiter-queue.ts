/**
 * The line of callers waiting on one gate (`concurrency.ts`): first in, first out, and a waiter
 * leaves from anywhere in it in constant time.
 *
 * A burst that queues behind a saturated gate also leaves it as a burst, by timers expiring or
 * clients cancelling, and a search-and-splice array makes each departure walk the whole line:
 * draining N waiters costs N squared on the event loop every other request shares. A doubly linked
 * line removes by handle, so a departure costs the same however long the line is.
 */

interface Link<T> {
  readonly value: T
  prev: Link<T> | undefined
  next: Link<T> | undefined
  /** False once the entry left, by {@link WaiterQueue.shift} or by its handle: a second leave is a no-op. */
  queued: boolean
}

/** What {@link WaiterQueue.push} returns: the only thing needed to take the waiter back out. */
export interface WaiterHandle {
  /** Takes the waiter out of the line. Idempotent: a waiter that already left is not touched again. */
  remove(): void
}

export interface WaiterQueue<T> {
  push(value: T): WaiterHandle
  /** The longest-waiting entry, removed; `undefined` when the line is empty. */
  shift(): T | undefined
  readonly size: number
}

export function createWaiterQueue<T>(): WaiterQueue<T> {
  let head: Link<T> | undefined
  let tail: Link<T> | undefined
  let size = 0

  const unlink = (link: Link<T>): void => {
    if (!link.queued) return
    link.queued = false
    if (link.prev === undefined) head = link.next
    else link.prev.next = link.next
    if (link.next === undefined) tail = link.prev
    else link.next.prev = link.prev
    link.prev = undefined
    link.next = undefined
    size -= 1
  }

  return {
    push: (value) => {
      const link: Link<T> = { value, prev: tail, next: undefined, queued: true }
      if (tail === undefined) head = link
      else tail.next = link
      tail = link
      size += 1
      return { remove: () => unlink(link) }
    },
    shift: () => {
      const first = head
      if (first === undefined) return undefined
      unlink(first)
      return first.value
    },
    get size() {
      return size
    },
  }
}
