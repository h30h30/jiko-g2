import {
  waitForEvenAppBridge,
  TextContainerProperty,
  CreateStartUpPageContainer,
  TextContainerUpgrade,
  OsEventTypeList,
} from '@evenrealities/even_hub_sdk'

const API =
  (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_API_URL ||
  'https://jiko-ob5s.onrender.com'
const TOKEN_KEY = 'jiko_token'
const MAX_LISTEN_MS = 15_000

const bridge = await waitForEvenAppBridge()

const mainText = new TextContainerProperty({
  xPosition: 0,
  yPosition: 0,
  width: 576,
  height: 288,
  borderWidth: 0,
  borderColor: 5,
  paddingLength: 4,
  containerID: 1,
  containerName: 'main',
  content: 'Jiko\nStarting...',
  isEventCapture: 1,
})

await bridge.createStartUpPageContainer(
  new CreateStartUpPageContainer({
    containerTotalNum: 1,
    textObject: [mainText],
  }),
)

const show = (text: string) =>
  bridge.textContainerUpgrade(
    new TextContainerUpgrade({ containerID: 1, containerName: 'main', content: text }),
  )

// Companion UI elements
const pairView = document.getElementById('pair-view')
const pairedView = document.getElementById('paired-view')
const codeInput = document.getElementById('code-input') as HTMLInputElement | null
const pairBtn = document.getElementById('pair-btn') as HTMLButtonElement | null
const pairMsg = document.getElementById('pair-msg')
const userInfo = document.getElementById('user-info')
const unpairBtn = document.getElementById('unpair-btn') as HTMLButtonElement | null

let token = ''
let liveBalance = ''
let cards: string[] = []
let cardIndex = 0
let lastCardsFetch = 0
let showingCard = false

try {
  token = localStorage.getItem(TOKEN_KEY) || ''
} catch {
  token = ''
}

function saveToken(t: string) {
  token = t
  try {
    if (t) localStorage.setItem(TOKEN_KEY, t)
    else localStorage.removeItem(TOKEN_KEY)
  } catch {
    // ignore storage errors
  }
}

function renderUnpaired(errorText = '') {
  pairView?.classList.remove('hidden')
  pairedView?.classList.add('hidden')
  if (pairMsg) pairMsg.textContent = errorText
}

function renderPaired(label: string, wallet: string) {
  pairView?.classList.add('hidden')
  pairedView?.classList.remove('hidden')
  if (userInfo) userInfo.textContent = label + ' · ' + wallet + ' (testnet)'
  if (pairMsg) pairMsg.textContent = ''
}

class AuthError extends Error {}

async function post(path: string, body: BodyInit, type: string) {
  const headers: Record<string, string> = { 'Content-Type': type }
  if (token) headers['x-jiko-token'] = token
  const res = await fetch(API + path, { method: 'POST', headers, body })
  const data = await res.json()
  if (res.status === 401) throw new AuthError(data.error || 'Not paired')
  if (!res.ok) throw new Error(data.error || String(res.status))
  return data
}
const postJson = (path: string, obj: unknown) => post(path, JSON.stringify(obj), 'application/json')

function eventTypeOf(envelope?: { eventType?: OsEventTypeList }): OsEventTypeList | null {
  if (!envelope) return null
  return envelope.eventType ?? OsEventTypeList.CLICK_EVENT
}

type State = 'idle' | 'listening' | 'busy' | 'confirming' | 'waiting'
let state: State = 'idle'
let parts: Uint8Array[] = []
let pendingId = ''
let cancelTimer: ReturnType<typeof setTimeout> | undefined
let listenTimer: ReturnType<typeof setTimeout> | undefined

function clearTimers() {
  if (cancelTimer) {
    clearTimeout(cancelTimer)
    cancelTimer = undefined
  }
  if (listenTimer) {
    clearTimeout(listenTimer)
    listenTimer = undefined
  }
}

const homeHeader = () => (liveBalance ? 'Jiko · ' + liveBalance + ' GRAM' : 'Jiko')

async function renderCurrentCard() {
  showingCard = true
  const body = cards[cardIndex] || homeHeader()
  await show(body + '\n\nUp/Down: cards · Tap: talk')
}

async function refreshCards(renderIfShowing = false) {
  if (!token) return
  try {
    const res = await postJson('/cards', {})
    if (res.ok && Array.isArray(res.cards) && res.cards.length) {
      cards = res.cards
      if (res.balance) liveBalance = String(res.balance)
      lastCardsFetch = Date.now()
      if (renderIfShowing && state === 'idle' && showingCard) {
        await renderCurrentCard()
      }
    }
  } catch (e) {
    if (e instanceof AuthError) await handleExpiredSession()
    else console.error('CARDS ERROR:', e)
  }
}

const idle = async (text: string) => {
  state = 'idle'
  pendingId = ''
  showingCard = false
  clearTimers()
  await show(text + '\n\nTap: talk · Up/Down: cards')
}

async function handleExpiredSession() {
  saveToken('')
  liveBalance = ''
  cards = []
  cardIndex = 0
  lastCardsFetch = 0
  showingCard = false
  state = 'idle'
  pendingId = ''
  clearTimers()
  renderUnpaired()
  await show('Jiko\nPair in phone app\nSend /pair to bot')
}

async function initSession() {
  if (!token) {
    renderUnpaired()
    await show('Jiko\nPair in phone app\nSend /pair to bot')
    return
  }
  try {
    const me = await postJson('/me', {})
    if (me.balance) liveBalance = String(me.balance)
    renderPaired(me.label, me.wallet)
    await show(homeHeader() + '\nLoading cards...')
    cardIndex = 0
    await refreshCards(false)
    await renderCurrentCard()
  } catch (e) {
    if (e instanceof AuthError) {
      await handleExpiredSession()
    } else {
      console.error(e)
      renderUnpaired('Cannot reach Jiko server.')
      await show('Jiko\nServer offline')
    }
  }
}

async function doPair() {
  const code = (codeInput?.value || '').trim()
  if (!code) {
    if (pairMsg) pairMsg.textContent = 'Enter the 6-digit code from Telegram.'
    return
  }
  if (pairBtn) pairBtn.disabled = true
  if (pairMsg) pairMsg.textContent = 'Pairing...'
  try {
    const res = await postJson('/pair', { code })
    if (!res.ok) {
      if (pairMsg) pairMsg.textContent = res.message || 'Pairing failed.'
      return
    }
    saveToken(res.token)
    if (res.balance) liveBalance = String(res.balance)
    if (codeInput) codeInput.value = ''
    renderPaired(res.label, res.wallet)
    cardIndex = 0
    await refreshCards(false)
    await renderCurrentCard()
  } catch (e) {
    console.error(e)
    if (pairMsg) pairMsg.textContent = 'Cannot reach Jiko server.'
  } finally {
    if (pairBtn) pairBtn.disabled = false
  }
}

pairBtn?.addEventListener('click', () => {
  void doPair()
})

codeInput?.addEventListener('keydown', e => {
  if (e.key === 'Enter') void doPair()
})

unpairBtn?.addEventListener('click', async () => {
  try {
    await postJson('/unpair', {})
  } catch {
    // ignore network errors on unpair
  }
  saveToken('')
  liveBalance = ''
  cards = []
  cardIndex = 0
  lastCardsFetch = 0
  showingCard = false
  state = 'idle'
  pendingId = ''
  clearTimers()
  renderUnpaired()
  await show('Jiko\nPair in phone app\nSend /pair to bot')
})

await initSession()

bridge.onEvenHubEvent(async event => {
  if (event.audioEvent) {
    if (state === 'listening') parts.push(new Uint8Array(event.audioEvent.audioPcm))
    return
  }

  const sysType = eventTypeOf(event.sysEvent)
  const textType = eventTypeOf(event.textEvent)

  // Up / Down card navigation on Even G2 when idle
  const isUp =
    sysType === OsEventTypeList.SCROLL_TOP_EVENT || textType === OsEventTypeList.SCROLL_TOP_EVENT
  const isDown =
    sysType === OsEventTypeList.SCROLL_BOTTOM_EVENT ||
    textType === OsEventTypeList.SCROLL_BOTTOM_EVENT

  if ((isUp || isDown) && state === 'idle' && token) {
    if (!cards.length) {
      await show('Loading cards...')
      await refreshCards(false)
      await renderCurrentCard()
      return
    }
    if (showingCard) {
      cardIndex = isDown
        ? (cardIndex + 1) % cards.length
        : (cardIndex + cards.length - 1) % cards.length
    }
    await renderCurrentCard()
    if (Date.now() - lastCardsFetch > 15_000) {
      void refreshCards(true)
    }
    return
  }

  if (sysType === OsEventTypeList.DOUBLE_CLICK_EVENT || textType === OsEventTypeList.DOUBLE_CLICK_EVENT) {
    if (state === 'busy') return
    clearTimers()
    if (state === 'idle') {
      await bridge.audioControl(false)
      bridge.shutDownPageContainer(1)
      return
    }
    await bridge.audioControl(false)
    parts = []
    await idle('Cancelled')
    return
  }

  if (sysType !== OsEventTypeList.CLICK_EVENT && textType !== OsEventTypeList.CLICK_EVENT) return

  if (!token) {
    await show('Jiko\nNot paired yet.\nEnter /pair code\nin phone app')
    return
  }

  if (state === 'waiting') {
    await idle('Stopped waiting')
    return
  }

  if (state === 'busy') return

  if (state === 'idle') {
    state = 'listening'
    showingCard = false
    parts = []
    await bridge.audioControl(true)
    await show('Listening...\nTap to stop (max 15s)')
    listenTimer = setTimeout(() => {
      if (state === 'listening') {
        void (async () => {
          await bridge.audioControl(false)
          parts = []
          await idle('No command heard.\n(15s limit reached)')
        })()
      }
    }, MAX_LISTEN_MS)
    return
  }

  if (state === 'listening') {
    clearTimers()
    state = 'busy'
    await bridge.audioControl(false)

    const total = parts.reduce((n, p) => n + p.length, 0)
    if (total < 3200) {
      return await idle('Too short.\nTap, speak, then tap again.')
    }

    await show('Thinking...')

    const pcm = new Uint8Array(total)
    let offset = 0
    for (const p of parts) {
      pcm.set(p, offset)
      offset += p.length
    }

    try {
      const { text } = await post('/voice', pcm, 'application/octet-stream')
      if (!text) return await idle('Nothing heard')
      const cmd = await postJson('/command', { text })
      if (!cmd.ok) return await idle(cmd.message + '\n\nHeard: "' + text + '"')
      if (cmd.refreshCards) {
        lastCardsFetch = 0
        void refreshCards(false)
      }
      if (cmd.type === 'balance') {
        if (cmd.balance) liveBalance = String(cmd.balance)
        return await idle(cmd.message)
      }
      if (cmd.type === 'history' || cmd.type === 'answer') {
        return await idle(cmd.message)
      }

      pendingId = cmd.id
      state = 'confirming'
      const actionLabel =
        cmd.type === 'invite'
          ? 'Tap = send invite'
          : cmd.type === 'ask'
            ? 'Tap = send request'
            : 'Tap = confirm'
      await show(cmd.summary + '\n\n' + actionLabel + '\n2x Tap = cancel (8s)')
      cancelTimer = setTimeout(() => {
        if (state === 'confirming') idle('Cancelled')
      }, 8000)
    } catch (e) {
      if (e instanceof AuthError) return await handleExpiredSession()
      console.error(e)
      await idle('Error\n(see console)')
    }
    return
  }

  if (state === 'confirming') {
    clearTimers()
    state = 'busy'
    try {
      const id = pendingId
      const r = await postJson('/confirm', { id })
      if (!r.ok) return await idle(r.message)
      if (r.type === 'invite' || r.type === 'ask') {
        return await idle(r.message || 'Done!')
      }

      state = 'waiting'
      await show('Sign in your wallet\n(see Telegram)\n\nTap to stop waiting')
      const startedAt = Date.now()
      while ((state as State) === 'waiting' && Date.now() - startedAt < 300_000) {
        await new Promise(res => setTimeout(res, 3000))
        if ((state as State) !== 'waiting') return
        const s = await postJson('/status', { id })
        if (s.status === 'sent') {
          lastCardsFetch = 0
          void refreshCards(false)
          return await idle('Sent!\n' + s.amount + ' GRAM to ' + s.label)
        }
        if (s.status === 'cancelled') return await idle('Cancelled in wallet')
        if (s.status === 'expired' || s.status === 'unknown') break
      }
      if ((state as State) === 'waiting') await idle('Not signed in time')
    } catch (e) {
      if (e instanceof AuthError) return await handleExpiredSession()
      console.error(e)
      await idle('Error\n(see console)')
    }
  }
})