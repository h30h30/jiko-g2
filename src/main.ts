import {
  waitForEvenAppBridge,
  TextContainerProperty,
  CreateStartUpPageContainer,
  TextContainerUpgrade,
  OsEventTypeList,
} from '@evenrealities/even_hub_sdk'

const API = 'http://127.0.0.1:8787'

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
  content: 'Jiko\nTap to talk',
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

// A single tap arrives with eventType undefined (protobuf omits 0), so it counts as CLICK.
function eventTypeOf(envelope?: { eventType?: OsEventTypeList }): OsEventTypeList | null {
  if (!envelope) return null
  return envelope.eventType ?? OsEventTypeList.CLICK_EVENT
}

async function post(path: string, body: BodyInit, type: string) {
  const res = await fetch(API + path, { method: 'POST', headers: { 'Content-Type': type }, body })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || String(res.status))
  return data
}
const postJson = (path: string, obj: unknown) => post(path, JSON.stringify(obj), 'application/json')

type State = 'idle' | 'listening' | 'busy' | 'confirming' | 'waiting'
let state: State = 'idle'
let parts: Uint8Array[] = []
let pendingId = ''
let cancelTimer: ReturnType<typeof setTimeout> | undefined

const idle = async (text: string) => {
  state = 'idle'
  pendingId = ''
  if (cancelTimer) clearTimeout(cancelTimer)
  await show(text + '\n\nTap to talk')
}

bridge.onEvenHubEvent(async event => {
  if (event.audioEvent) {
    if (state === 'listening') parts.push(new Uint8Array(event.audioEvent.audioPcm))
    return
  }

  const sysType = eventTypeOf(event.sysEvent)
  const textType = eventTypeOf(event.textEvent)

  if (sysType === OsEventTypeList.DOUBLE_CLICK_EVENT || textType === OsEventTypeList.DOUBLE_CLICK_EVENT) {
    if (cancelTimer) clearTimeout(cancelTimer)
    await bridge.audioControl(false)
    bridge.shutDownPageContainer(1)
    return
  }

  if (sysType !== OsEventTypeList.CLICK_EVENT && textType !== OsEventTypeList.CLICK_EVENT) return

  if (state === 'waiting') {
    await idle('Stopped waiting')
    return
  }

  if (state === 'busy') return

  if (state === 'idle') {
    state = 'listening'
    parts = []
    await bridge.audioControl(true)
    await show('Listening...\nTap to stop')
    return
  }

  if (state === 'listening') {
    state = 'busy'
    await bridge.audioControl(false)
    await show('Thinking...')

    const total = parts.reduce((n, p) => n + p.length, 0)
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
      pendingId = cmd.id
      state = 'confirming'
      await show(cmd.summary + '\n\nTap = confirm\n(auto-cancel in 8 s)')
      cancelTimer = setTimeout(() => {
        if (state === 'confirming') idle('Cancelled')
      }, 8000)
    } catch (e) {
      console.error(e)
      await idle('Error\n(see console)')
    }
    return
  }

  if (state === 'confirming') {
    state = 'busy'
    if (cancelTimer) clearTimeout(cancelTimer)
    try {
      const id = pendingId
      const r = await postJson('/confirm', { id })
      if (!r.ok) return await idle(r.message)
      state = 'waiting'
      await show('Sign in your wallet\n(see Telegram)\n\nTap to stop waiting')
      const startedAt = Date.now()
      while ((state as State) === 'waiting' && Date.now() - startedAt < 300_000) {
        await new Promise(res => setTimeout(res, 3000))
        if ((state as State) !== 'waiting') return
        const s = await postJson('/status', { id })
        if (s.status === 'sent') return await idle('Sent ✅\n' + s.amount + ' GRAM to ' + s.label)
        if (s.status === 'expired' || s.status === 'unknown') break
      }
      if ((state as State) === 'waiting') await idle('Not signed in time')
    } catch (e) {
      console.error(e)
      await idle('Error\n(see console)')
    }
  }
})