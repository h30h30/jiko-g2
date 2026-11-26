const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";

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

async function getDbSchema() {
  const dbId = cleanDatabaseId(process.env.NOTION_DATABASE_ID);
  if (cachedSchema && cachedSchema.dbId === dbId) return cachedSchema;

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

  for (const [key, prop] of Object.entries(props)) {
    if (prop.type === "title") titleKey = key;
    if (!tagKey && (prop.type === "multi_select" || prop.type === "select")) {
      tagKey = key;
      tagType = prop.type;
    }
  }

  cachedSchema = { dbId, titleKey, tagKey, tagType };
  return cachedSchema;
}

export async function saveNotionEntry({ kind = "note", title, details = "" }) {
  if (!isNotionEnabled()) throw new Error("Notion not configured");
  const t0 = Date.now();
  const schema = await getDbSchema();

  const properties = {
    [schema.titleKey]: {
      title: [{ text: { content: String(title || "Untitled").slice(0, 180) } }],
    },
  };

  if (schema.tagKey) {
    const tagLabel = kind === "tip" ? "Crypto Tip" : "Voice Note";
    if (schema.tagType === "multi_select") {
      properties[schema.tagKey] = { multi_select: [{ name: tagLabel }] };
    } else if (schema.tagType === "select") {
      properties[schema.tagKey] = { select: { name: tagLabel } };
    }
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

    entries.push({
      title,
      tag,
      date: (page.created_time ?? "").slice(0, 10),
    });
  }
  return entries;
}

export async function fetchRecentNotionEntries(limit = 3) {
  const entries = await fetchNotionEntriesData(limit);
  if (!entries.length) return "Notion log is empty.";
  const lines = entries.map((e) => {
    const clipped = e.title.length > 32 ? e.title.slice(0, 29) + "..." : e.title;
    return "- " + clipped;
  });
  return "Notion log:\n" + lines.join("\n");
}