const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";
const SCHEMA_TTL_MS = 60_000;

let cachedSchema = null;

function cleanDatabaseId(raw) {
  if (!raw) return "";
  const base = String(raw).trim().split("?")[0].replace(/\/+$/, "");
  const m = base.match(
    /([0-9a-fA-F]{32}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/
  );
  return m ? m[1] : base;
}

export function isNotionEnabled() {
  return Boolean(process.env.NOTION_API_KEY && cleanDatabaseId(process.env.NOTION_DATABASE_ID));
}

function notionHeaders() {
  return {
    Authorization: "Bearer " + process.env.NOTION_API_KEY,
    "Notion-Version": NOTION_VERSION,
    "Content-Type": "application/json",
  };
}

async function getDbSchema(force = false) {
  const dbId = cleanDatabaseId(process.env.NOTION_DATABASE_ID);
  if (!force && cachedSchema && cachedSchema.dbId === dbId && Date.now() - cachedSchema.at < SCHEMA_TTL_MS) {
    return cachedSchema;
  }

  const res = await fetch(`${NOTION_API}/databases/${dbId}`, {
    method: "GET",
    headers: notionHeaders(),
  });
  if (!res.ok) {
    const errText = (await res.text()).slice(0, 200);
    throw new Error(`Notion schema ${res.status}: ${errText}`);
  }
  const db = await res.json();
  const props = db.properties ?? {};

  let titleKey = "Name";
  let tagKey = null;
  let tagType = null;
  let doneKey = null;
  let amountKey = null;
  let usdKey = null;
  let dueKey = null;

  for (const [key, prop] of Object.entries(props)) {
    if (prop.type === "title") titleKey = key;
    if (!tagKey && (prop.type === "multi_select" || prop.type === "select")) {
      tagKey = key;
      tagType = prop.type;
    }
    if (prop.type === "checkbox") {
      if (!doneKey || /done|complete|check|status/i.test(key)) doneKey = key;
    }
    if (prop.type === "number") {
      if (/usd|dollar|ref|price|value/i.test(key)) usdKey = key;
      else if (/amount|gram|ton|qty/i.test(key)) amountKey = key;
    }
    if (prop.type === "date") {
      if (!dueKey || /due|deadline|date/i.test(key)) dueKey = key;
    }
  }

  cachedSchema = { dbId, titleKey, tagKey, tagType, doneKey, amountKey, usdKey, dueKey, at: Date.now() };
  return cachedSchema;
}

export async function saveNotionEntry({
  kind = "note",
  title,
  details = "",
  amount = null,
  usdRef = null,
  done = false,
  due = null,
}) {
  if (!isNotionEnabled()) throw new Error("Notion not configured");
  const t0 = Date.now();
  const schema = await getDbSchema();

  const properties = {
    [schema.titleKey]: {
      title: [{ text: { content: String(title || "Untitled").slice(0, 180) } }],
    },
  };

  if (schema.tagKey) {
    const tagLabel = kind === "tip" ? "Crypto Tip" : kind === "task" ? "Task" : "Voice Note";
    if (schema.tagType === "multi_select") {
      properties[schema.tagKey] = { multi_select: [{ name: tagLabel }] };
    } else if (schema.tagType === "select") {
      properties[schema.tagKey] = { select: { name: tagLabel } };
    }
  }

  if (schema.doneKey && kind === "task") {
    properties[schema.doneKey] = { checkbox: Boolean(done) };
  }

  if (schema.amountKey && amount !== null && Number.isFinite(Number(amount))) {
    properties[schema.amountKey] = { number: Number(Number(amount).toFixed(4)) };
  }

  if (schema.usdKey && usdRef !== null && Number.isFinite(Number(usdRef))) {
    properties[schema.usdKey] = { number: Number(Number(usdRef).toFixed(2)) };
  }

  if (schema.dueKey && due && /^\d{4}-\d{2}-\d{2}$/.test(String(due).trim())) {
    properties[schema.dueKey] = { date: { start: String(due).trim() } };
  }

  const body = {
    parent: { database_id: schema.dbId },
    properties,
  };

  if (details) {
    body.children = [
      {
        object: "block",
        type: "paragraph",
        paragraph: {
          rich_text: [{ type: "text", text: { content: String(details).slice(0, 1800) } }],
        },
      },
    ];
  }

  const res = await fetch(`${NOTION_API}/pages`, {
    method: "POST",
    headers: notionHeaders(),
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = (await res.text()).slice(0, 200);
    throw new Error(`Notion save ${res.status}: ${errText}`);
  }
  console.log(`[TIMING] Notion save (${kind}): ${((Date.now() - t0) / 1000).toFixed(2)}s`);
  return await res.json();
}

export async function fetchNotionEntriesData(limit = 25) {
  if (!isNotionEnabled()) throw new Error("Notion not configured");
  const t0 = Date.now();
  const schema = await getDbSchema();

  const res = await fetch(`${NOTION_API}/databases/${schema.dbId}/query`, {
    method: "POST",
    headers: notionHeaders(),
    body: JSON.stringify({
      page_size: limit,
      sorts: [{ timestamp: "created_time", direction: "descending" }],
    }),
  });

  if (!res.ok) {
    const errText = (await res.text()).slice(0, 200);
    throw new Error(`Notion query ${res.status}: ${errText}`);
  }

  const json = await res.json();
  console.log(`[TIMING] Notion query (${limit}): ${((Date.now() - t0) / 1000).toFixed(2)}s`);

  const entries = [];
  for (const page of json.results ?? []) {
    const titleProp = page.properties?.[schema.titleKey];
    const title = (titleProp?.title ?? [])
      .map((t) => t.plain_text ?? "")
      .join("")
      .trim();
    if (!title) continue;

    let tag = "";
    if (schema.tagKey && page.properties?.[schema.tagKey]) {
      const tp = page.properties[schema.tagKey];
      if (tp.type === "select") tag = tp.select?.name ?? "";
      else if (tp.type === "multi_select") tag = (tp.multi_select ?? []).map((x) => x.name).join(", ");
    }

    const done = schema.doneKey ? Boolean(page.properties?.[schema.doneKey]?.checkbox) : false;
    const rawAmt = schema.amountKey ? page.properties?.[schema.amountKey]?.number : null;
    const rawUsd = schema.usdKey ? page.properties?.[schema.usdKey]?.number : null;
    const due = schema.dueKey ? page.properties?.[schema.dueKey]?.date?.start ?? "" : "";

    entries.push({
      id: page.id,
      title,
      tag,
      done,
      hasDoneProp: Boolean(schema.doneKey),
      amount: typeof rawAmt === "number" ? rawAmt : null,
      usdRef: typeof rawUsd === "number" ? rawUsd : null,
      due,
      date: (page.created_time ?? "").slice(0, 10),
    });
  }
  return entries;
}

export async function fetchOpenTasks(limit = 30) {
  const entries = await fetchNotionEntriesData(limit);
  return entries.filter((e) => /task/i.test(e.tag) && !e.done);
}

const tokenize = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 2 && !/^(the|my|a|an|to|as|is|in|on|for|task|item|done|complete|finished)$/.test(w));

function scoreMatch(title, query) {
  const t = String(title || "").toLowerCase();
  const q = String(query || "").toLowerCase().trim();
  if (!q) return 0;
  if (t === q) return 100;
  if (t.includes(q)) return 80;
  const qWords = tokenize(q);
  if (!qWords.length) return 0;
  const tWords = tokenize(t);
  let hits = 0;
  for (const qw of qWords) {
    if (tWords.some((tw) => tw === qw || tw.includes(qw) || qw.includes(tw))) hits++;
  }
  return hits > 0 ? Math.round((hits / qWords.length) * 60) + hits * 5 : 0;
}

export async function completeNotionTask(query) {
  if (!isNotionEnabled()) throw new Error("Notion not configured");
  const schema = await getDbSchema(true);
  if (!schema.doneKey) {
    return { ok: false, missingCheckbox: true };
  }

  const entries = await fetchNotionEntriesData(30);
  const openTasks = entries.filter((e) => /task/i.test(e.tag) && !e.done);
  const openOthers = entries.filter((e) => !/task/i.test(e.tag) && !/crypto tip/i.test(e.tag) && !e.done);
  const cleanQuery = String(query || "").trim();

  let target = null;
  if (!cleanQuery || /^(last|latest|recent|first|top|it|that)$/i.test(cleanQuery)) {
    target = openTasks[0] || openOthers[0] || null;
  } else {
    const pickBest = (list) => {
      let best = null;
      let bestScore = 0;
      for (const item of list) {
        const s = scoreMatch(item.title, cleanQuery);
        if (s > bestScore) {
          bestScore = s;
          best = item;
        }
      }
      return bestScore >= 20 ? best : null;
    };
    target = pickBest(openTasks) || pickBest(openOthers);
  }

  if (!target) {
    return { ok: false, notFound: true };
  }

  const t0 = Date.now();
  const res = await fetch(`${NOTION_API}/pages/${target.id}`, {
    method: "PATCH",
    headers: notionHeaders(),
    body: JSON.stringify({
      properties: {
        [schema.doneKey]: { checkbox: true },
      },
    }),
  });

  if (!res.ok) {
    const errText = (await res.text()).slice(0, 200);
    throw new Error(`Notion update ${res.status}: ${errText}`);
  }
  console.log(`[TIMING] Notion complete task: ${((Date.now() - t0) / 1000).toFixed(2)}s`);
  return { ok: true, task: target };
}

export async function searchNotionEntries(query, limit = 30) {
  const entries = await fetchNotionEntriesData(limit);
  const scored = entries
    .map((e) => ({ entry: e, score: scoreMatch(`${e.title} ${e.tag} ${e.due}`, query) }))
    .filter((x) => x.score >= 20)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.entry);
  return { matched: scored, all: entries };
}

export async function fetchRecentNotionEntries(limit = 3) {
  const entries = await fetchNotionEntriesData(limit);
  if (!entries.length) return "Notion log is empty.";
  const lines = entries.map((e) => {
    const isTask = /task/i.test(e.tag);
    const prefix = isTask ? (e.done ? "[x] " : "[ ] ") : "- ";
    const maxLen = isTask ? 28 : 31;
    const clipped = e.title.length > maxLen ? e.title.slice(0, maxLen - 3) + "..." : e.title;
    return prefix + clipped;
  });
  return "Notion log:\n" + lines.join("\n");
}