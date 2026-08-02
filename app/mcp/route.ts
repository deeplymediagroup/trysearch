/**
 * /mcp — hosted MCP server (05-API-ROUTES.md §3), streamable-HTTP transport, stateless.
 * Every tool maps 1:1 onto the shared op registry, prefixed `search_`, so the MCP surface
 * and the REST API can never drift apart.
 *
 * Install (no package needed):
 *   claude mcp add --transport http trysearch https://<host>/mcp --header "Authorization: Bearer <key>"
 *
 * ponytail: plain JSON-RPC over POST, no SDK. Initialize/tools-list/tools-call is ~all of
 * the protocol a stateless tool server needs; add the SDK if sessions/resources ever matter.
 */
import { NextRequest, NextResponse } from "next/server";
import { OPS, ApiError, runOp } from "@/lib/api-core";
import { authenticate } from "@/lib/api-auth";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const PROTOCOL_VERSION = "2025-06-18";

function rpcError(id: unknown, code: number, message: string, status = 200) {
  return NextResponse.json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } }, { status });
}

function rpcResult(id: unknown, result: unknown) {
  return NextResponse.json({ jsonrpc: "2.0", id, result });
}

export async function POST(req: NextRequest) {
  let identity;
  try {
    identity = await authenticate(req);
  } catch (err) {
    const e = err instanceof ApiError ? err : new ApiError("internal_error", "Auth failed.", 500);
    return NextResponse.json({ error: { code: e.code, message: e.message } }, { status: e.status });
  }

  let msg: any;
  try {
    msg = await req.json();
  } catch {
    return rpcError(null, -32700, "Parse error.");
  }
  const { id, method, params } = msg ?? {};

  try {
    switch (method) {
      case "initialize":
        return rpcResult(id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: "trysearch", version: "1.0.0" },
          instructions:
            "Live App Store / Google Play ASO data: keyword popularity & difficulty, rankings, competitors, reviews, listing audits. Workspace tools (search_list_apps, search_app_keywords, ...) read the connected trysearch workspace; research tools work on any public app.",
        });

      case "notifications/initialized":
        return new NextResponse(null, { status: 202 });

      case "ping":
        return rpcResult(id, {});

      case "tools/list":
        return rpcResult(id, {
          // A read-only key is not shown the write tools at all. Listing a tool the caller
          // cannot use just invites the agent to try it and read a 403 as a bug.
          tools: Object.entries(OPS)
            .filter(([, op]) => identity.scope === "write" || !op.write)
            .map(([name, op]) => ({
              name: `search_${name}`,
              description: op.description,
              inputSchema: op.schema,
            })),
        });

      case "tools/call": {
        const toolName: string = params?.name ?? "";
        const opName = toolName.replace(/^search_/, "");
        if (!OPS[opName] || !toolName.startsWith("search_")) return rpcError(id, -32602, `Unknown tool: ${toolName}`);
        try {
          const result = await runOp(opName, params?.arguments ?? {}, identity);
          return rpcResult(id, { content: [{ type: "text", text: JSON.stringify(result) }] });
        } catch (err: any) {
          // Tool-level failures are results with isError, not protocol errors.
          return rpcResult(id, { content: [{ type: "text", text: err.message }], isError: true });
        }
      }

      default:
        // Unknown notifications are acknowledged; unknown requests are errors.
        if (typeof method === "string" && method.startsWith("notifications/")) return new NextResponse(null, { status: 202 });
        return rpcError(id, -32601, `Method not found: ${method}`);
    }
  } catch (err: any) {
    return rpcError(id, -32000, err.message ?? "Server error.");
  }
}

/** Stateless server: no SSE stream to offer. */
export async function GET() {
  return new NextResponse("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
}
