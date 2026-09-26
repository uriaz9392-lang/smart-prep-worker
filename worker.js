// Smart Prep — MCQ Bank + Leaderboard + Generic App-Data CDN Worker
//
// MCQ bank endpoints (unchanged):
//   GET  /bank              -> full question bank
//   GET  /bank-version       -> just the version number
//   PUT  /bank              -> updates the bank (needs x-admin-key header)
//
// Leaderboard endpoints (unchanged):
//   GET  /leaderboard        -> cached leaderboard (top 50), auto-refreshed every 5 minutes
//   GET  /leaderboard/refresh -> forces an immediate refresh right now (manual override,
//                                useful right after fixing a Supabase policy, so you don't
//                                have to wait for the next scheduled 5-minute refresh)
//
// Generic app-data endpoints (NEW):
//   GET  /data/:name          -> cached value for that resource, or "null" if never cached yet
//   GET  /data/:name/version  -> { version: n } for that resource
//   PUT  /data/:name          -> updates the cached value + bumps its version (needs x-admin-key)
//
// ":name" can be anything (examdates, flptests, dailyreminder, notes, ...) — this Worker
// never needs editing again to cache one more thing; only the app's own code needs to
// start calling GET/PUT on a new name. Every name is stored completely independently
// (its own KV key + its own version counter), so caching one resource never touches
// another's data.

const ADMIN_KEY = "THpKGBzsM4dtsa9ruyvmlxbD6AzPfMwB-ZOawZmHSqY";
const SUPABASE_URL = "https://ehkrddewmmilogbojvkh.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_q_gmTPI3dh6wqAqgHDXKpg_wrTkA5ia";

async function refreshLeaderboard(env) {
  // Added `course` to the select list so the app can filter the leaderboard
  // down to each student's own course. Requires the `course` column to exist
  // on user_stats in Supabase (alter table user_stats add column if not
  // exists course text;) — if it doesn't exist yet, Supabase will just error
  // on this request the same way it would for any other missing column.
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/user_stats?select=name,total_attempted,total_correct,course&order=total_correct.desc&limit=50`,
    {
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      },
    }
  );
  if (!res.ok) throw new Error("Supabase leaderboard fetch failed: " + res.status);
  const rows = await res.json();
  const cleaned = (rows || [])
    .filter((r) => r.name && r.name.trim())
    .map((r) => ({
      name: r.name,
      total_attempted: r.total_attempted,
      total_correct: r.total_correct,
      course: r.course || null,
    }));
  await env.MCQ_BANK.put("leaderboard", JSON.stringify(cleaned));
  await env.MCQ_BANK.put("leaderboard-updated", String(Date.now()));
  return cleaned;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, x-admin-key",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: cors });
    }

    if (url.pathname === "/bank-version" && request.method === "GET") {
      const version = (await env.MCQ_BANK.get("version")) || "1";
      return new Response(JSON.stringify({ version: Number(version) }), {
        headers: { "Content-Type": "application/json", ...cors },
      });
    }

    if (url.pathname === "/bank" && request.method === "GET") {
      const bank = await env.MCQ_BANK.get("bank");
      return new Response(bank || "[]", {
        headers: { "Content-Type": "application/json", ...cors },
      });
    }

    if (url.pathname === "/bank" && request.method === "PUT") {
      const key = request.headers.get("x-admin-key");
      if (key !== ADMIN_KEY) {
        return new Response("Unauthorized", { status: 401, headers: cors });
      }
      const body = await request.text();
      const currentVersion = Number((await env.MCQ_BANK.get("version")) || "1");
      const nextVersion = currentVersion + 1;
      await env.MCQ_BANK.put("bank", body);
      await env.MCQ_BANK.put("version", String(nextVersion));
      return new Response(JSON.stringify({ ok: true, version: nextVersion }), {
        headers: { "Content-Type": "application/json", ...cors },
      });
    }

    if (url.pathname === "/leaderboard" && request.method === "GET") {
      let cached = await env.MCQ_BANK.get("leaderboard");
      if (cached === null) {
        try {
          await refreshLeaderboard(env);
          cached = await env.MCQ_BANK.get("leaderboard");
        } catch (e) {
          return new Response("[]", { headers: { "Content-Type": "application/json", ...cors } });
        }
      }
      return new Response(cached || "[]", {
        headers: { "Content-Type": "application/json", ...cors },
      });
    }

    if (url.pathname === "/leaderboard/refresh" && request.method === "GET") {
      try {
        const data = await refreshLeaderboard(env);
        return new Response(JSON.stringify({ ok: true, count: data.length, data }), {
          headers: { "Content-Type": "application/json", ...cors },
        });
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: String(e) }), {
          status: 500,
          headers: { "Content-Type": "application/json", ...cors },
        });
      }
    }

    // ---- Generic app-data caching: /data/:name and /data/:name/version ----
    // One namespaced KV key per resource ("data:examdates", "data:flptests",
    // etc.) plus its own version counter ("data:examdates:version") — kept
    // fully separate from the bank's own "bank"/"version" keys above so
    // nothing here can ever collide with or affect bank caching.
    const dataMatch = url.pathname.match(/^\/data\/([a-zA-Z0-9_-]+)(\/version)?$/);
    if (dataMatch) {
      const name = dataMatch[1];
      const isVersionPath = !!dataMatch[2];
      const kvKey = `data:${name}`;
      const versionKey = `data:${name}:version`;

      if (isVersionPath && request.method === "GET") {
        const version = (await env.MCQ_BANK.get(versionKey)) || "0";
        return new Response(JSON.stringify({ version: Number(version) }), {
          headers: { "Content-Type": "application/json", ...cors },
        });
      }

      if (!isVersionPath && request.method === "GET") {
        const value = await env.MCQ_BANK.get(kvKey);
        // "null" (not "[]" or "{}") on a cache miss — the app treats an
        // actual JSON null as "nothing cached yet, go ask Supabase", the
        // same way it already does for the bank.
        return new Response(value === null ? "null" : value, {
          headers: { "Content-Type": "application/json", ...cors },
        });
      }

      if (!isVersionPath && request.method === "PUT") {
        const key = request.headers.get("x-admin-key");
        if (key !== ADMIN_KEY) {
          return new Response("Unauthorized", { status: 401, headers: cors });
        }
        const body = await request.text();
        const currentVersion = Number((await env.MCQ_BANK.get(versionKey)) || "0");
        const nextVersion = currentVersion + 1;
        await env.MCQ_BANK.put(kvKey, body);
        await env.MCQ_BANK.put(versionKey, String(nextVersion));
        return new Response(JSON.stringify({ ok: true, version: nextVersion }), {
          headers: { "Content-Type": "application/json", ...cors },
        });
      }
    }

    return new Response("Not found", { status: 404, headers: cors });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(refreshLeaderboard(env));
  },
};
