// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'

import { COLLAPSIBLE_CARD_TRIGGER_SLOTS } from '../browser/webview/collapsibleCardSlots'
import {
  containerClaiming,
  descendToOrdinal,
  expandAllWithin,
  expandContainer,
  MAX_FLASH_VIEWPORT_RATIO,
  revealThreadMessage,
} from '../browser/webview/revealThreadMessage'
import { resetRowPinRequestsForTests } from '../browser/webview/rowPinRequests'

/**
 * happy-dom reports every rect as 0×0, and the reveal deliberately
 * ignores zero-box elements. So a test has to say how tall things are.
 */
function stubHeight(el: HTMLElement, height: number): void {
  el.getBoundingClientRect = () =>
    ({
      height,
      width: 600,
      top: 0,
      bottom: height,
      left: 0,
      right: 600,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect
  el.scrollIntoView = () => {}
}

function build(html: string, heights: Record<string, number>): HTMLElement {
  document.body.innerHTML = html
  const root = document.body.firstElementChild as HTMLElement
  stubHeight(root, 900)
  for (const [selector, height] of Object.entries(heights)) {
    for (const el of root.querySelectorAll<HTMLElement>(selector)) {
      stubHeight(el, height)
    }
  }
  return root
}

/**
 * A collapsed card that renders its children only once opened — the
 * behaviour the whole descent exists for. It declares the line range it
 * covers WHILE CLOSED, because a closed card has no children to ask.
 */
function collapsedCard(
  id: string,
  from: number,
  to: number | null,
  reveal: (card: HTMLElement) => void,
): HTMLElement {
  const card = document.createElement('div')
  card.id = id
  card.dataset.lineFrom = String(from)
  if (to !== null) card.dataset.lineTo = String(to)
  const trigger = document.createElement('div')
  // A REAL trigger slot from the app. The bare shadcn name
  // (`collapsible-trigger`) is not used anywhere in the conversation, and
  // a fixture that used it let a broken expander pass these tests while
  // opening nothing on screen.
  trigger.setAttribute('data-slot', 'tool-fallback-trigger')
  trigger.dataset.state = 'closed'
  trigger.addEventListener('click', () => {
    trigger.dataset.state = 'open'
    reveal(card)
  })
  card.appendChild(trigger)
  stubHeight(card, 60)
  stubHeight(trigger, 20)
  return card
}

function line(ordinal: number, text: string): HTMLElement {
  const el = document.createElement('p')
  el.dataset.lineOrdinal = String(ordinal)
  el.textContent = text
  stubHeight(el, 24)
  return el
}

describe('containerClaiming', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  function siblings(spans: [number, number | null][]): HTMLElement {
    const root = build(`<div class="row"></div>`, {})
    for (const [from, to] of spans) {
      const el = document.createElement('div')
      el.dataset.lineFrom = String(from)
      if (to !== null) el.dataset.lineTo = String(to)
      el.id = `c${from}`
      root.appendChild(el)
    }
    return root
  }

  it('picks the container the line falls into, not the first one', () => {
    // Three containers in one turn — a model that starts a second todo
    // group mid-turn produces exactly this. Line 34 belongs to the one
    // starting at 30, and "expand whatever is in the gap" would have
    // opened the wrong one.
    const root = siblings([
      [10, 29],
      [30, 44],
      [45, 60],
    ])
    expect(containerClaiming(root, 34)?.id).toBe('c30')
    expect(containerClaiming(root, 10)?.id).toBe('c10')
    expect(containerClaiming(root, 45)?.id).toBe('c45')
  })

  it('respects a declared end, so a gap between containers is not claimed', () => {
    // Line 25 sits between the two cards — it belongs to the row itself,
    // and attributing it to the earlier card would send the walk into a
    // container that cannot produce it.
    const root = siblings([
      [10, 20],
      [30, 40],
    ])
    expect(containerClaiming(root, 25)).toBeNull()
  })

  it('falls back to the floor when the end is unknown', () => {
    // A container still streaming does not know where it ends yet.
    const root = siblings([
      [10, null],
      [30, null],
    ])
    expect(containerClaiming(root, 34)?.id).toBe('c30')
    expect(containerClaiming(root, 12)?.id).toBe('c10')
  })

  it('is null when every container starts after the line', () => {
    expect(containerClaiming(siblings([[30, 40]]), 5)).toBeNull()
  })
})

describe('descendToOrdinal', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('returns the leaf directly when it is already rendered', async () => {
    const root = build(`<div class="row"></div>`, {})
    root.appendChild(line(9, 'nine'))
    root.appendChild(line(50, 'fifty'))
    expect((await descendToOrdinal(root, 50))?.textContent).toBe('fifty')
  })

  it('opens the claiming container, then finds the line inside it', async () => {
    const root = build(`<div class="row"></div>`, {})
    root.appendChild(line(9, 'nine'))
    const card = collapsedCard('card', 10, 49, held => {
      held.appendChild(line(34, 'the hit'))
    })
    root.appendChild(card)
    root.appendChild(line(50, 'fifty'))

    expect((await descendToOrdinal(root, 34))?.textContent).toBe('the hit')
  })

  it('descends through nested containers', async () => {
    // Opening one card reveals another card, not the line — the walk has
    // to ask again at each level instead of expanding once and giving up.
    const root = build(`<div class="row"></div>`, {})
    const outer = collapsedCard('outer', 10, 49, held => {
      const inner = collapsedCard('inner', 30, 40, deeper => {
        deeper.appendChild(line(34, 'buried'))
      })
      held.appendChild(inner)
    })
    root.appendChild(outer)

    expect((await descendToOrdinal(root, 34))?.textContent).toBe('buried')
  })

  it('settles on the deepest container when no leaf carries the line', async () => {
    // A card whose body renders a summary rather than the raw transcript
    // line: there is no leaf to land on, but the card IS the right place
    // and it is now open. Returning nothing here is what used to send the
    // reveal back to the top of the message.
    const root = build(`<div class="row"></div>`, {})
    const card = collapsedCard('card', 10, 49, held => {
      const summary = document.createElement('p')
      summary.textContent = '2 results'
      stubHeight(summary, 20)
      held.appendChild(summary)
    })
    root.appendChild(card)

    expect((await descendToOrdinal(root, 34))?.id).toBe('card')
  })

  it('keeps going past a container that carries the line to the leaf inside', async () => {
    // A tool card carries its own line AND holds the block that renders
    // it. Stopping at the card is what "it flashes the wrapper, not the
    // item" looks like — the walk has to end on the innermost thing that
    // carries the line.
    const root = build(`<div class="row"></div>`, {})
    const card = collapsedCard('card', 34, 40, held => {
      const inner = line(34, 'the actual line')
      held.appendChild(inner)
    })
    card.dataset.lineOrdinal = '34'
    root.appendChild(card)

    const found = await descendToOrdinal(root, 34)
    expect(found?.textContent).toBe('the actual line')
    expect(found?.id).not.toBe('card')
  })

  it('opens the real card triggers, not just the bare shadcn one', async () => {
    // One case per real trigger name, driven by the shared slot list so a card added there is pinned here too.
    expect(COLLAPSIBLE_CARD_TRIGGER_SLOTS).toContain('plan-list-item-trigger')
    for (const slot of COLLAPSIBLE_CARD_TRIGGER_SLOTS) {
      document.body.innerHTML = ''
      const root = build(`<div class="row"></div>`, {})
      const card = document.createElement('div')
      card.dataset.lineFrom = '10'
      card.dataset.lineTo = '49'
      const trigger = document.createElement('div')
      trigger.setAttribute('data-slot', slot)
      trigger.dataset.state = 'closed'
      trigger.addEventListener('click', () => {
        trigger.dataset.state = 'open'
        card.appendChild(line(34, `opened via ${slot}`))
      })
      card.appendChild(trigger)
      stubHeight(card, 60)
      stubHeight(trigger, 20)
      root.appendChild(card)

      const found = await descendToOrdinal(root, 34)
      expect(found?.textContent).toBe(`opened via ${slot}`)
    }
  })

  it('reaches a leaf hidden behind a card that declares no range', async () => {
    // Not every card carries a range — only those built from a tool-call
    // part do. A card that declares nothing is invisible to the targeted
    // descent, so its labelled grandchildren are unreachable and the walk
    // stops on the grandparent. The level sweep is what gets past it.
    const root = build(`<div class="row"></div>`, {})
    const silent = document.createElement('div') // no data-line-from
    const trigger = document.createElement('div')
    trigger.setAttribute('data-slot', 'tool-group-trigger')
    trigger.dataset.state = 'closed'
    trigger.addEventListener('click', () => {
      trigger.dataset.state = 'open'
      silent.appendChild(line(34, 'the grandchild'))
    })
    silent.appendChild(trigger)
    stubHeight(silent, 60)
    stubHeight(trigger, 20)
    root.appendChild(silent)

    expect((await descendToOrdinal(root, 34))?.textContent).toBe(
      'the grandchild',
    )
  })

  it('never clicks a tooltip trigger (the fork / rewind / copy buttons)', async () => {
    // THE fork bug. Every message action button is a TooltipIconButton →
    // <TooltipTrigger asChild>, so it renders data-slot="tooltip-trigger"
    // with data-state="closed" while idle. The old suffix selector
    // `[data-slot$="-trigger"]` matched it, and `.click()` ran the button's
    // onClick even while the action bar was hidden — so revealing a
    // message clicked its "Fork from here", minting a new session and
    // loading the message into the composer. Pin BOTH click paths:
    // expandContainer (targeted open) and expandAllWithin (level sweep).
    const row = build(`<div class="row"></div>`, {})
    const fork = document.createElement('button')
    fork.setAttribute('data-slot', 'tooltip-trigger')
    fork.dataset.state = 'closed'
    let forked = 0
    fork.addEventListener('click', () => {
      forked += 1
    })
    row.appendChild(fork)

    expect(expandContainer(row)).toBe(false) // no CARD trigger to open
    expect(expandAllWithin(row)).toBe(0) // sweep opens no cards
    expect(forked).toBe(0) // and crucially never fired the fork button
  })

  it('is null when no container claims the line', async () => {
    const root = build(`<div class="row"></div>`, {})
    root.appendChild(line(9, 'nine'))
    expect(await descendToOrdinal(root, 34)).toBeNull()
  })

  it('still looks for the leaf when the budget has already run out', async () => {
    // The budget bounds expansions and their render waits, not lookups.
    // Mounting the row can eat the whole budget on a slow page (measured:
    // 9 s from `running` to the row appearing, on a throttled debug
    // window), and a walk that checked the clock BEFORE its first look
    // returned null with the leaf sitting right there — `quiet`, on a hit
    // that needed nothing opened at all.
    const root = build(`<div class="row"></div>`, {})
    root.appendChild(line(9, 'nine'))
    root.appendChild(line(34, 'the hit'))
    const expired = Date.now() - 1
    expect((await descendToOrdinal(root, 34, expired))?.textContent).toBe(
      'the hit',
    )
  })

  it('past the budget it settles on the claiming card without opening it', async () => {
    // Out of time, an expansion would start a render nobody waits for. The
    // card is the right place; hand it back closed.
    const root = build(`<div class="row"></div>`, {})
    let opened = 0
    const card = collapsedCard('card', 10, 49, held => {
      opened += 1
      held.appendChild(line(34, 'the hit'))
    })
    root.appendChild(card)
    const expired = Date.now() - 1
    expect((await descendToOrdinal(root, 34, expired))?.id).toBe('card')
    expect(opened).toBe(0)
  })

  it('stops on the visible text of a long user message, never on its hidden body or its toggle', async () => {
    // The shape `UserMessage` renders for a collapsed long message: the
    // bubble carries the line, the collapsed preview inside it carries the
    // line, the full body is mounted but hidden and carries NOTHING, and
    // the "show full" control is a bare shadcn `collapsible-trigger`. The
    // innermost VISIBLE carrier is the preview — the walk must end there.
    // Ending on the bubble would open the toggle looking for something
    // deeper (and then flash the toggle); a stamped hidden body would be
    // "innermost" and win, and the reveal would mark an invisible element.
    const root = build(`<div class="row"></div>`, {})
    const bubble = document.createElement('div')
    bubble.className = 'aui-user-message-content'
    bubble.dataset.lineOrdinal = '72'
    const preview = document.createElement('div')
    preview.dataset.role = 'user-message-preview'
    preview.dataset.lineOrdinal = '72'
    preview.textContent = 'the first ten lines'
    const hiddenFull = document.createElement('div')
    hiddenFull.dataset.role = 'user-message-full'
    hiddenFull.hidden = true
    const toggle = document.createElement('button')
    toggle.setAttribute('data-slot', 'collapsible-trigger')
    toggle.dataset.state = 'closed'
    let opened = 0
    toggle.addEventListener('click', () => {
      opened += 1
    })
    bubble.append(preview, hiddenFull, toggle)
    stubHeight(bubble, 260)
    stubHeight(preview, 240)
    stubHeight(hiddenFull, 0)
    stubHeight(toggle, 20)
    root.appendChild(bubble)

    const found = await descendToOrdinal(root, 72)
    expect(found?.dataset.role).toBe('user-message-preview')
    expect(opened).toBe(0)
  })
})

describe('revealThreadMessage', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    resetRowPinRequestsForTests()
  })

  function thread(rowHtml: string, heights: Record<string, number>) {
    return build(
      `<div class="thread"><div class="aui-thread-viewport">${rowHtml}</div></div>`,
      heights,
    )
  }

  it('flashes the line the ordinal names', async () => {
    const root = thread(`<div data-message-index="0" class="row"></div>`, {
      '.row': 200,
    })
    const row = root.querySelector<HTMLElement>('.row')!
    row.appendChild(line(9, 'nine'))
    row.appendChild(line(34, 'the hit'))

    expect(await revealThreadMessage(root, 0, 34)).toBe(true)
    const flashed = root.querySelectorAll('[data-search-hit="true"]')
    expect(flashed).toHaveLength(1)
    expect(flashed[0]?.textContent).toBe('the hit')
    expect(root.getAttribute('data-search-reveal')).toBe('line')
  })

  it('opens a collapsed card to reach the line', async () => {
    const root = thread(`<div data-message-index="0" class="row"></div>`, {
      '.row': 300,
    })
    const row = root.querySelector<HTMLElement>('.row')!
    row.appendChild(line(9, 'nine'))
    const card = collapsedCard('card', 10, 49, held => {
      held.appendChild(line(34, 'the hit'))
    })
    row.appendChild(card)

    expect(await revealThreadMessage(root, 0, 34)).toBe(true)
    const flashed = root.querySelectorAll('[data-search-hit="true"]')
    expect(flashed[0]?.textContent).toBe('the hit')
  })

  it('stays quiet rather than flashing a line it cannot justify', async () => {
    // The row is right — it gets marked — but nothing in it carries the
    // ordinal. Flashing an arbitrary line here is what made every hit in
    // one row look identical.
    const root = thread(`<div data-message-index="0" class="row"></div>`, {
      '.row': 200,
    })
    root.querySelector<HTMLElement>('.row')!.appendChild(line(9, 'nine'))

    expect(await revealThreadMessage(root, 0, 34)).toBe(true)
    expect(root.querySelectorAll('[data-search-hit="true"]')).toHaveLength(0)
    expect(root.querySelector('[data-search-target="true"]')).not.toBeNull()
    expect(root.getAttribute('data-search-reveal')).toBe('quiet')
  })

  it('a newer reveal wins — the older one marks nothing', async () => {
    // Clicking a second hit while the first is still expanding used to
    // let the older walk finish and stamp ITS row over the newer one's,
    // which reads as a jump landing on the wrong message.
    const root = thread(
      `<div data-message-index="0" class="row"></div>
       <div data-message-index="1" class="row2"></div>`,
      { '.row': 200, '.row2': 200 },
    )
    root.querySelector<HTMLElement>('.row')!.appendChild(line(10, 'older'))
    root.querySelector<HTMLElement>('.row2')!.appendChild(line(20, 'newer'))

    const older = revealThreadMessage(root, 0, 10)
    const newer = revealThreadMessage(root, 1, 20)
    expect(await newer).toBe(true)
    expect(await older).toBe(false)

    const flashed = root.querySelectorAll('[data-search-hit="true"]')
    expect(flashed).toHaveLength(1)
    expect(flashed[0]?.textContent).toBe('newer')
  })

  it('reports missing when the row never mounts', async () => {
    const root = thread('', {})
    expect(await revealThreadMessage(root, 7, 34)).toBe(false)
    expect(root.getAttribute('data-search-reveal')).toBe('missing')
  })

  it('falls back to a line inside an oversized target', async () => {
    // The ordinal names something taller than the flash cap — a band
    // across it would read as the page blinking, so mark its first line.
    const tall = Math.round(
      window.innerHeight * (MAX_FLASH_VIEWPORT_RATIO + 0.3),
    )
    const root = thread(`<div data-message-index="0" class="row"></div>`, {
      '.row': 400,
    })
    const big = document.createElement('div')
    big.dataset.lineOrdinal = '34'
    stubHeight(big, tall)
    const head = document.createElement('p')
    head.id = 'head'
    head.textContent = 'PowerShell'
    stubHeight(head, 20)
    big.appendChild(head)
    root.querySelector<HTMLElement>('.row')!.appendChild(big)

    expect(await revealThreadMessage(root, 0, 34)).toBe(true)
    const flashed = root.querySelectorAll('[data-search-hit="true"]')
    expect(flashed).toHaveLength(1)
    expect(flashed[0]?.id).toBe('head')
  })

  it('flashes a user bubble that carries the line, as one box', async () => {
    // What a `userText` hit looks like once the user row declares its line
    // (`user-message-line.render.test.ts`): the bubble is the innermost
    // carrier and small enough to flash — so it flashes, whole, and the
    // outcome is `line`, not `quiet`.
    const root = thread(`<div data-message-index="0" class="row"></div>`, {
      '.row': 140,
    })
    const bubble = document.createElement('div')
    bubble.className = 'aui-user-message-content'
    bubble.dataset.lineOrdinal = '72'
    bubble.textContent = '实现这个 last_event_time + idle，但是注意两种不同的provider'
    stubHeight(bubble, 92)
    root.querySelector<HTMLElement>('.row')!.appendChild(bubble)

    expect(await revealThreadMessage(root, 0, 72, 'last_event_time + idle')).toBe(true)
    const flashed = root.querySelectorAll('[data-search-hit="true"]')
    expect(flashed).toHaveLength(1)
    expect(flashed[0]).toBe(bubble)
    expect(root.getAttribute('data-search-reveal')).toBe('line')
  })

  it('flashes the line itself when it is over the cap and holds nothing smaller', async () => {
    // A plain-text element carrying the ordinal — a long user message in a
    // short window — has no children to fall back to. The cap exists so a
    // CONTAINER standing for many lines is not flashed as if it were the
    // hit; an element that IS the line is never the wrong thing to mark,
    // only a big one. Going quiet here left the click doing nothing
    // visible at all.
    const tall = Math.round(
      window.innerHeight * (MAX_FLASH_VIEWPORT_RATIO + 0.3),
    )
    const root = thread(`<div data-message-index="0" class="row"></div>`, {
      '.row': tall + 40,
    })
    const text = document.createElement('div')
    text.dataset.lineOrdinal = '72'
    text.textContent = 'a very long user message with no child elements at all'
    stubHeight(text, tall)
    root.querySelector<HTMLElement>('.row')!.appendChild(text)

    expect(await revealThreadMessage(root, 0, 72, 'no child')).toBe(true)
    const flashed = root.querySelectorAll('[data-search-hit="true"]')
    expect(flashed).toHaveLength(1)
    expect(flashed[0]).toBe(text)
    expect(root.getAttribute('data-search-reveal')).toBe('line')
  })

  it('still stays quiet on a container over the cap that holds nothing smaller', async () => {
    // The counterpart: the walk ended on a card that stands for a RANGE
    // (declares from/to, carries no ordinal of its own). Nothing inside it
    // can be justified, and marking the card would say "the match is this
    // whole card" — the thing the cap is there to prevent.
    const tall = Math.round(
      window.innerHeight * (MAX_FLASH_VIEWPORT_RATIO + 0.3),
    )
    const root = thread(`<div data-message-index="0" class="row"></div>`, {
      '.row': tall + 40,
    })
    const card = document.createElement('div')
    card.dataset.lineFrom = '60'
    card.dataset.lineTo = '90'
    card.textContent = 'a summary'
    stubHeight(card, tall)
    root.querySelector<HTMLElement>('.row')!.appendChild(card)

    expect(await revealThreadMessage(root, 0, 72)).toBe(true)
    expect(root.querySelectorAll('[data-search-hit="true"]')).toHaveLength(0)
    expect(root.getAttribute('data-search-reveal')).toBe('quiet')
  })
})
