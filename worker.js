// Smart Prep — MCQ Bank + Leaderboard CDN Worker
//
// MCQ bank endpoints:
//   GET  /bank              -> full question bank
//   GET  /bank-version       -> just the version number
//   PUT  /bank              -> updates the bank (needs x-admin-key header)
//
// Leaderboard endpoints:
//   GET  /leaderboard        -> cached leaderboard (top 50), auto-refreshed every 5 minutes
//   GET  /leaderboard/refresh -> forces an immediate refresh right now (manual override,
//                                useful right after fixing a Supabase policy, so you don't
//                                have to wait for the next scheduled 5-minute refresh)

const ADMIN_KEY = "THpKGBzsM4dtsa9ruyvmlxbD6AzPfMwB-ZOawZmHSqY";
const SUPABASE_URL = "https://ehkrddewmmilogbojvkh.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_q_gmTPI3dh6wqAqgHDXKpg_wrTkA5ia";

async function refreshLeaderboard(env) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/user_stats?select=name,total_attempted,total_correct&order=total_correct.desc&limit=50`,
    {
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      },
    }
  );
  if (!res.ok) throw new Error("Supabase leaderboard fetch failed: " + res.status);
  const rows = await res.json();
  const cleaned = (rows || []).filter((r) => r.name && r.name.trim());
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

    return new Response("Not found", { status: 404, headers: cors });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(refreshLeaderboard(env));
  },
};