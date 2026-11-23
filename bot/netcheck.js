try {
  const res = await fetch("https://api.telegram.org/", { signal: AbortSignal.timeout(15000) });
  console.log("reachable, status:", res.status);
} catch (e) {
  console.log("FAILED:", e.cause?.code || e.name, e.message);
}
